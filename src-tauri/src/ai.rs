use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::Manager;
use tokio::sync::Notify;

// AI 流式代理（DESIGN.md §13.1）：双协议适配（Anthropic Messages / OpenAI
// Chat Completions），reqwest SSE → Tauri Channel 逐增量推送。
// Key 存系统钥匙串（keyring），配置文件不落密钥（NFR-9）。

const KEYRING_SERVICE: &str = "bmd";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    /// "anthropic" | "openai"
    pub protocol: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallMsg {
    pub id: String,
    pub name: String,
    /// JSON 字符串形式的调用参数（流式增量拼装的原文）
    pub arguments: String,
}

/// 随消息附带的图片（识图）：base64 原文 + MIME
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub media_type: String,
    pub data_b64: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// role=assistant 时可携带的工具调用（Agent 循环回传历史用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallMsg>>,
    /// role=tool 时对应的调用 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// role=user 时可附带的图片（识图；需模型支持视觉输入）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<ImageAttachment>>,
}

/// 工具定义（前端下发；parameters 为 JSON Schema）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AiEvent {
    Delta { text: String },
    ToolCalls { calls: Vec<ToolCallMsg> },
    Done,
    Error { message: String },
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---- 密钥管理 ----

#[tauri::command]
pub async fn set_api_key(provider_id: String, key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &provider_id).map_err(err)?;
    if key.is_empty() {
        let _ = entry.delete_credential();
        Ok(())
    } else {
        entry.set_password(&key).map_err(err)
    }
}

#[tauri::command]
pub async fn has_api_key(provider_id: String) -> Result<bool, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &provider_id).map_err(err)?;
    Ok(entry.get_password().is_ok())
}

fn get_key(provider_id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, provider_id)
        .ok()?
        .get_password()
        .ok()
}

// ---- 取消 ----

fn cancels() -> &'static Mutex<HashSet<String>> {
    static C: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 进行中请求的取消唤醒器：流停滞时也能立即中断（不必等下一个 chunk）
fn cancel_notifies() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn ai_cancel(request_id: String) -> Result<(), String> {
    cancels().lock().unwrap().insert(request_id.clone());
    if let Some(n) = cancel_notifies().lock().unwrap().get(&request_id) {
        n.notify_one();
    }
    Ok(())
}

// ---- SSE 解析（纯函数，回放测试覆盖，R8） ----

/// 从 SSE data 载荷中按协议提取文本增量
pub fn extract_delta(protocol: &str, data: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    match protocol {
        "anthropic" => {
            if v["type"] == "content_block_delta" {
                v["delta"]["text"].as_str().map(str::to_string)
            } else {
                None
            }
        }
        // OpenAI 兼容（GPT/DeepSeek/Kimi/MiniMax/Qwen/GLM/Ollama）；
        // usage 尾块 choices 为空、reasoning_content 增量均自然落空
        _ => v["choices"][0]["delta"]["content"].as_str().map(str::to_string),
    }
}

/// 识别"HTTP 200 但流内报错"的各家方言
pub fn extract_error(protocol: &str, data: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    if protocol == "anthropic" {
        // event: error → {"type":"error","error":{"type":…,"message":…}}
        if v["type"] == "error" {
            return Some(v["error"]["message"].as_str().unwrap_or("未知错误").to_string());
        }
        return None;
    }
    // OpenAI 系流内错误：{"error":{"message":…}}
    if let Some(msg) = v["error"]["message"].as_str() {
        return Some(msg.to_string());
    }
    // MiniMax：base_resp.status_code 非零即错（0 是随流的正常回执）
    if let Some(code) = v["base_resp"]["status_code"].as_i64() {
        if code != 0 {
            let msg = v["base_resp"]["status_msg"].as_str().unwrap_or("");
            return Some(format!("MiniMax {code}: {msg}"));
        }
    }
    None
}

/// 从字节缓冲中吐出完整的 "data:" 载荷。
/// 缓冲必须是字节而非 String：chunk 边界可能切在多字节 UTF-8 字符中间
/// （中文流式输出常态），只有完整行才能安全解码。
pub fn drain_sse_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        let line = String::from_utf8_lossy(&line);
        let line = line.trim_end();
        if let Some(data) = line.strip_prefix("data:") {
            out.push(data.trim().to_string());
        }
    }
    out
}

/// 解析出的流事件（生产循环与回放测试共用同一条管线）
#[derive(Debug, PartialEq)]
pub enum SseItem {
    Delta(String),
    ToolCalls(Vec<ToolCallMsg>),
    Error(String),
    Done,
}

/// 跨行聚合状态：工具调用的 id/name 先到、参数 JSON 分片后到，
/// 必须攒到停止信号才能整体产出
#[derive(Default)]
pub struct SseState {
    /// (流内 index, 调用) —— 保序；OpenAI 按 index 归并，Anthropic 按 content block index
    pending: Vec<(i64, ToolCallMsg)>,
    emitted: bool,
}

impl SseState {
    fn upsert(&mut self, index: i64) -> &mut ToolCallMsg {
        if let Some(pos) = self.pending.iter().position(|(i, _)| *i == index) {
            return &mut self.pending[pos].1;
        }
        self.pending.push((
            index,
            ToolCallMsg { id: String::new(), name: String::new(), arguments: String::new() },
        ));
        &mut self.pending.last_mut().unwrap().1
    }

    /// 取出攒齐的调用（每流至多产出一次；空集或已产出返回 None）
    fn flush(&mut self) -> Option<Vec<ToolCallMsg>> {
        if self.emitted || self.pending.is_empty() {
            return None;
        }
        self.emitted = true;
        Some(self.pending.drain(..).map(|(_, c)| c).collect())
    }
}

/// 按协议解析工具调用相关行；命中停止信号时产出攒齐的调用集
fn extract_tool_piece(protocol: &str, state: &mut SseState, data: &str) -> Option<Vec<ToolCallMsg>> {
    let v: serde_json::Value = serde_json::from_str(data).ok()?;
    if protocol == "anthropic" {
        match v["type"].as_str()? {
            "content_block_start" if v["content_block"]["type"] == "tool_use" => {
                let idx = v["index"].as_i64().unwrap_or(0);
                let call = state.upsert(idx);
                call.id = v["content_block"]["id"].as_str().unwrap_or_default().to_string();
                call.name = v["content_block"]["name"].as_str().unwrap_or_default().to_string();
            }
            "content_block_delta" if v["delta"]["type"] == "input_json_delta" => {
                let idx = v["index"].as_i64().unwrap_or(0);
                if let Some(part) = v["delta"]["partial_json"].as_str() {
                    state.upsert(idx).arguments.push_str(part);
                }
            }
            // 停止信号：stop_reason=tool_use（message_stop 由流末尾兜底 flush）
            "message_delta" if v["delta"]["stop_reason"] == "tool_use" => return state.flush(),
            _ => {}
        }
        return None;
    }
    // OpenAI 系：delta.tool_calls 增量 + finish_reason=tool_calls 停止
    let choice = &v["choices"][0];
    if let Some(calls) = choice["delta"]["tool_calls"].as_array() {
        for c in calls {
            let idx = c["index"].as_i64().unwrap_or(0);
            let slot = state.upsert(idx);
            if let Some(id) = c["id"].as_str() {
                slot.id = id.to_string();
            }
            if let Some(name) = c["function"]["name"].as_str() {
                slot.name = name.to_string();
            }
            if let Some(part) = c["function"]["arguments"].as_str() {
                slot.arguments.push_str(part);
            }
        }
    }
    if choice["finish_reason"] == "tool_calls" {
        return state.flush();
    }
    None
}

/// 处理一段新到的字节，按序产出事件
pub fn process_chunk(
    protocol: &str,
    state: &mut SseState,
    buf: &mut Vec<u8>,
    chunk: &[u8],
) -> Vec<SseItem> {
    buf.extend_from_slice(chunk);
    let mut out = Vec::new();
    for data in drain_sse_lines(buf) {
        if data == "[DONE]" {
            // 个别端点不发 finish_reason=tool_calls，[DONE] 前兜底 flush
            if let Some(calls) = state.flush() {
                out.push(SseItem::ToolCalls(calls));
            }
            out.push(SseItem::Done);
            continue;
        }
        if let Some(m) = extract_error(protocol, &data) {
            out.push(SseItem::Error(m));
            continue;
        }
        if let Some(calls) = extract_tool_piece(protocol, state, &data) {
            out.push(SseItem::ToolCalls(calls));
            continue;
        }
        if let Some(t) = extract_delta(protocol, &data) {
            if !t.is_empty() {
                out.push(SseItem::Delta(t));
            }
        }
    }
    out
}

// ---- 请求构建 ----

/// 把统一消息映射为 Anthropic Messages 格式。
/// 约束：连续的 role=tool 结果必须合并进同一条 user 消息（配对上一轮多工具调用）。
fn anthropic_messages(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut i = 0;
    while i < messages.len() {
        let m = &messages[i];
        if m.role == "tool" {
            let mut blocks: Vec<serde_json::Value> = Vec::new();
            while i < messages.len() && messages[i].role == "tool" {
                blocks.push(serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": messages[i].tool_call_id.clone().unwrap_or_default(),
                    "content": messages[i].content,
                }));
                i += 1;
            }
            out.push(serde_json::json!({ "role": "user", "content": blocks }));
            continue;
        }
        if let Some(calls) = &m.tool_calls {
            let mut blocks: Vec<serde_json::Value> = Vec::new();
            if !m.content.is_empty() {
                blocks.push(serde_json::json!({ "type": "text", "text": m.content }));
            }
            for c in calls {
                let input: serde_json::Value =
                    serde_json::from_str(&c.arguments).unwrap_or(serde_json::json!({}));
                blocks.push(serde_json::json!({
                    "type": "tool_use", "id": c.id, "name": c.name, "input": input,
                }));
            }
            out.push(serde_json::json!({ "role": m.role, "content": blocks }));
        } else if let Some(images) = m.images.as_ref().filter(|v| !v.is_empty()) {
            // 识图：图片块在前、文本在后（Anthropic 官方推荐顺序）
            let mut blocks: Vec<serde_json::Value> = images.iter().map(|img| {
                serde_json::json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": img.media_type, "data": img.data_b64 },
                })
            }).collect();
            // Anthropic 拒绝空 text 块：纯图消息不追加文本
            if !m.content.is_empty() {
                blocks.push(serde_json::json!({ "type": "text", "text": m.content }));
            }
            out.push(serde_json::json!({ "role": m.role, "content": blocks }));
        } else {
            out.push(serde_json::json!({ "role": m.role, "content": m.content }));
        }
        i += 1;
    }
    out
}

/// 把统一消息映射为 OpenAI Chat Completions 格式
fn openai_messages(system: &Option<String>, messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    let mut msgs: Vec<serde_json::Value> = Vec::new();
    if let Some(s) = system {
        msgs.push(serde_json::json!({ "role": "system", "content": s }));
    }
    for m in messages {
        if m.role == "tool" {
            msgs.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": m.tool_call_id.clone().unwrap_or_default(),
                "content": m.content,
            }));
        } else if let Some(calls) = &m.tool_calls {
            let tool_calls: Vec<serde_json::Value> = calls.iter().map(|c| {
                serde_json::json!({
                    "id": c.id, "type": "function",
                    "function": { "name": c.name, "arguments": c.arguments },
                })
            }).collect();
            msgs.push(serde_json::json!({
                "role": m.role, "content": m.content, "tool_calls": tool_calls,
            }));
        } else if let Some(images) = m.images.as_ref().filter(|v| !v.is_empty()) {
            // 识图：OpenAI 兼容的 image_url data URL 形态
            let mut parts: Vec<serde_json::Value> = images.iter().map(|img| {
                serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:{};base64,{}", img.media_type, img.data_b64) },
                })
            }).collect();
            if !m.content.is_empty() {
                parts.push(serde_json::json!({ "type": "text", "text": m.content }));
            }
            msgs.push(serde_json::json!({ "role": m.role, "content": parts }));
        } else {
            msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
        }
    }
    msgs
}

fn build_request(
    client: &reqwest::Client,
    provider: &ProviderConfig,
    system: &Option<String>,
    messages: &[ChatMessage],
    tools: &Option<Vec<ToolDef>>,
    key: &Option<String>,
) -> reqwest::RequestBuilder {
    let base = provider.base_url.trim_end_matches('/');
    if provider.protocol == "anthropic" {
        let mut body = serde_json::json!({
            "model": provider.model,
            "max_tokens": 8192,
            "stream": true,
            "system": system.clone().unwrap_or_default(),
            "messages": anthropic_messages(messages),
        });
        if let Some(ts) = tools {
            if !ts.is_empty() {
                body["tools"] = ts.iter().map(|t| {
                    serde_json::json!({
                        "name": t.name, "description": t.description,
                        "input_schema": t.parameters,
                    })
                }).collect();
            }
        }
        let mut r = client
            .post(format!("{base}/v1/messages"))
            .header("anthropic-version", "2023-06-01")
            .json(&body);
        if let Some(k) = key {
            r = r.header("x-api-key", k);
        }
        r
    } else {
        let mut body = serde_json::json!({
            "model": provider.model,
            "stream": true,
            "messages": openai_messages(system, messages),
        });
        if let Some(ts) = tools {
            if !ts.is_empty() {
                body["tools"] = ts.iter().map(|t| {
                    serde_json::json!({
                        "type": "function",
                        "function": { "name": t.name, "description": t.description, "parameters": t.parameters },
                    })
                }).collect();
            }
        }
        let mut r = client.post(format!("{base}/chat/completions")).json(&body);
        if let Some(k) = key {
            r = r.bearer_auth(k);
        }
        r
    }
}

#[tauri::command]
pub async fn ai_chat(
    request_id: String,
    provider: ProviderConfig,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    tools: Option<Vec<ToolDef>>,
    on_event: Channel<AiEvent>,
) -> Result<(), String> {
    cancels().lock().unwrap().remove(&request_id);
    let notify = Arc::new(Notify::new());
    cancel_notifies()
        .lock()
        .unwrap()
        .insert(request_id.clone(), notify.clone());
    let key = get_key(&provider.id);
    // 仅限连接阶段超时；流式响应本身可长时间进行，不设总超时
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            cancel_notifies().lock().unwrap().remove(&request_id);
            return Err(err(e));
        }
    };
    let result = run_chat(
        &client, &request_id, &provider, &system, &messages, &tools, &key, &on_event, &notify,
    )
    .await;
    // 请求结束后统一清理注册表与取消标记，避免迟到的 ai_cancel 永久残留
    cancel_notifies().lock().unwrap().remove(&request_id);
    cancels().lock().unwrap().remove(&request_id);
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_chat(
    client: &reqwest::Client,
    request_id: &str,
    provider: &ProviderConfig,
    system: &Option<String>,
    messages: &[ChatMessage],
    tools: &Option<Vec<ToolDef>>,
    key: &Option<String>,
    on_event: &Channel<AiEvent>,
    cancel: &Notify,
) -> Result<(), String> {
    // 连接阶段也可被取消
    let sent = tokio::select! {
        biased;
        _ = cancel.notified() => return Ok(()),
        r = build_request(client, provider, system, messages, tools, key).send() => r,
    };
    let resp = sent.map_err(err)?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let _ = on_event.send(AiEvent::Error {
            message: format!("HTTP {status}: {}", text.chars().take(400).collect::<String>()),
        });
        return Ok(());
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut state = SseState::default();
    loop {
        // select 取消唤醒：流停滞时 ai_cancel 也能立即中断连接
        let next = tokio::select! {
            biased;
            _ = cancel.notified() => return Ok(()),
            c = stream.next() => c,
        };
        let Some(chunk) = next else { break };
        if cancels().lock().unwrap().remove(request_id) {
            return Ok(());
        }
        let chunk = chunk.map_err(err)?;
        for item in process_chunk(&provider.protocol, &mut state, &mut buf, &chunk) {
            match item {
                SseItem::Done => {
                    let _ = on_event.send(AiEvent::Done);
                    return Ok(());
                }
                SseItem::Error(message) => {
                    let _ = on_event.send(AiEvent::Error { message });
                    return Ok(());
                }
                SseItem::ToolCalls(calls) => {
                    if on_event.send(AiEvent::ToolCalls { calls }).is_err() {
                        return Ok(());
                    }
                }
                SseItem::Delta(text) => {
                    if on_event.send(AiEvent::Delta { text }).is_err() {
                        return Ok(());
                    }
                }
            }
        }
    }
    // 流自然结束（Anthropic 无 [DONE]）：兜底产出攒齐的工具调用
    if let Some(calls) = state.flush() {
        let _ = on_event.send(AiEvent::ToolCalls { calls });
    }
    let _ = on_event.send(AiEvent::Done);
    Ok(())
}

// ---- 会话持久化（AppData/chats/<hash>.json） ----

fn chats_file(app: &tauri::AppHandle, workspace: &str) -> Result<std::path::PathBuf, String> {
    use sha2::{Digest, Sha256};
    let dir = app.path().app_data_dir().map_err(err)?.join("chats");
    std::fs::create_dir_all(&dir).map_err(err)?;
    // sha256 前 8 字节：跨 Rust 版本稳定（DefaultHasher 不保证）
    let digest = Sha256::digest(workspace.as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    let file = dir.join(format!("{hex}.json"));
    // 迁移：旧版命名（DefaultHasher）的存档存在且新档不存在时改名沿用
    if !file.exists() {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        workspace.hash(&mut h);
        let legacy = dir.join(format!("{:x}.json", h.finish()));
        if legacy.exists() {
            let _ = std::fs::rename(&legacy, &file);
        }
    }
    Ok(file)
}

#[tauri::command]
pub async fn load_chats(app: tauri::AppHandle, workspace: String) -> Result<String, String> {
    let file = chats_file(&app, &workspace)?;
    if !file.exists() {
        return Ok("null".into());
    }
    std::fs::read_to_string(&file).map_err(err)
}

#[tauri::command]
pub async fn save_chats(app: tauri::AppHandle, workspace: String, json: String) -> Result<(), String> {
    let file = chats_file(&app, &workspace)?;
    // 原子写：临时文件 + rename，崩溃不截断存档
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(err)?;
    std::fs::rename(&tmp, &file).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_line_draining_handles_partial_chunks() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(b"data: {\"a\":1}\n\ndata: par");
        assert_eq!(drain_sse_lines(&mut buf), vec!["{\"a\":1}"]);
        assert_eq!(buf, b"data: par");
        buf.extend_from_slice(b"tial\n");
        assert_eq!(drain_sse_lines(&mut buf), vec!["partial"]);
    }

    // ---- 逐预设回放（R8）：按各家文档方言构造样本，恶意字节边界切块喂入 ----

    /// 以 n 字节为步长切块回放（刻意切碎多字节 UTF-8 字符），
    /// 汇总 (拼装文本, 首个错误, 是否见到 [DONE])
    fn replay(protocol: &str, raw: &[u8], n: usize) -> (String, Option<String>, bool) {
        let (text, error, done, _) = replay_full(protocol, raw, n);
        (text, error, done)
    }

    /// replay 的完整版：额外返回攒齐的工具调用
    fn replay_full(
        protocol: &str,
        raw: &[u8],
        n: usize,
    ) -> (String, Option<String>, bool, Vec<ToolCallMsg>) {
        let mut buf: Vec<u8> = Vec::new();
        let mut state = SseState::default();
        let (mut text, mut error, mut done) = (String::new(), None, false);
        let mut calls: Vec<ToolCallMsg> = Vec::new();
        for chunk in raw.chunks(n) {
            for item in process_chunk(protocol, &mut state, &mut buf, chunk) {
                match item {
                    SseItem::Delta(t) => text.push_str(&t),
                    SseItem::ToolCalls(c) => calls.extend(c),
                    SseItem::Error(e) => {
                        if error.is_none() {
                            error = Some(e);
                        }
                    }
                    SseItem::Done => done = true,
                }
            }
        }
        // 流末尾兜底（对应 run_chat 循环结束后的 flush）
        if let Some(c) = state.flush() {
            calls.extend(c);
        }
        (text, error, done, calls)
    }

    #[test]
    fn replay_claude_anthropic_event_stream() {
        let raw = concat!(
            "event: message_start\n",
            r#"data: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-5","usage":{"input_tokens":25}}}"#, "\n\n",
            "event: content_block_start\n",
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#, "\n\n",
            "event: ping\n",
            r#"data: {"type": "ping"}"#, "\n\n",
            "event: content_block_delta\n",
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好，"}}"#, "\n\n",
            "event: content_block_delta\n",
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世界！"}}"#, "\n\n",
            "event: content_block_stop\n",
            r#"data: {"type":"content_block_stop","index":0}"#, "\n\n",
            "event: message_delta\n",
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}"#, "\n\n",
            "event: message_stop\n",
            r#"data: {"type":"message_stop"}"#, "\n\n",
        );
        // 3 字节步长必然切碎每个汉字（UTF-8 三字节）
        let (text, error, _) = replay("anthropic", raw.as_bytes(), 3);
        assert_eq!(text, "你好，世界！");
        assert!(!text.contains('\u{FFFD}'), "UTF-8 断字导致乱码");
        assert_eq!(error, None);
    }

    #[test]
    fn replay_claude_error_event() {
        let raw = concat!(
            "event: error\n",
            r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#, "\n\n",
        );
        let (text, error, _) = replay("anthropic", raw.as_bytes(), 7);
        assert_eq!(text, "");
        assert_eq!(error.as_deref(), Some("Overloaded"));
    }

    #[test]
    fn replay_gpt_with_usage_tail_and_done() {
        // OpenAI：首块只有 role、尾部 finish_reason 空增量、
        // stream_options 的 usage 块 choices 为空数组，最后 [DONE]
        let raw = concat!(
            r#"data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}"#, "\n\n",
            r#"data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hello"}}]}"#, "\n\n",
            r#"data: {"id":"c1","choices":[{"index":0,"delta":{"content":"，你好"}}]}"#, "\n\n",
            r#"data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#, "\n\n",
            r#"data: {"id":"c1","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":7}}"#, "\n\n",
            "data: [DONE]\n\n",
        );
        let (text, error, done) = replay("openai", raw.as_bytes(), 3);
        assert_eq!(text, "Hello，你好");
        assert_eq!(error, None);
        assert!(done);
    }

    #[test]
    fn replay_deepseek_reasoner_ignores_reasoning_and_keepalive() {
        // deepseek-reasoner：先流 reasoning_content（content 为 null），再流正文；
        // 空闲时发 ": keep-alive" 注释行
        let raw = concat!(
            ": keep-alive\n\n",
            r#"data: {"choices":[{"index":0,"delta":{"reasoning_content":"思考中…","content":null}}]}"#, "\n\n",
            r#"data: {"choices":[{"index":0,"delta":{"reasoning_content":null,"content":"答案是"}}]}"#, "\n\n",
            r#"data: {"choices":[{"index":0,"delta":{"content":"42"}}]}"#, "\n\n",
            r#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#, "\n\n",
            "data: [DONE]\n\n",
        );
        let (text, error, done) = replay("openai", raw.as_bytes(), 5);
        assert_eq!(text, "答案是42");
        assert_eq!(error, None);
        assert!(done);
    }

    #[test]
    fn replay_kimi_with_trailing_usage_in_choice() {
        // Moonshot/Kimi：最后一个增量块在 choice 内带 usage
        let raw = concat!(
            r#"data: {"id":"k1","choices":[{"index":0,"delta":{"role":"assistant","content":"月之"}}]}"#, "\n\n",
            r#"data: {"id":"k1","choices":[{"index":0,"delta":{"content":"暗面"},"finish_reason":"stop","usage":{"total_tokens":16}}]}"#, "\n\n",
            "data: [DONE]\n\n",
        );
        let (text, error, done) = replay("openai", raw.as_bytes(), 3);
        assert_eq!(text, "月之暗面");
        assert_eq!(error, None);
        assert!(done);
    }

    #[test]
    fn replay_glm_stream() {
        // 智谱 GLM open.bigmodel.cn/api/paas/v4：标准 OpenAI 方言
        let raw = concat!(
            r#"data: {"id":"g1","created":1,"model":"glm-4-plus","choices":[{"index":0,"delta":{"role":"assistant","content":"智谱"}}]}"#, "\n\n",
            r#"data: {"id":"g1","choices":[{"index":0,"delta":{"content":"清言"}}]}"#, "\n\n",
            r#"data: {"id":"g1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":8}}"#, "\n\n",
            "data: [DONE]\n\n",
        );
        let (text, error, done) = replay("openai", raw.as_bytes(), 4);
        assert_eq!(text, "智谱清言");
        assert_eq!(error, None);
        assert!(done);
    }

    #[test]
    fn replay_minimax_base_resp_ok_is_not_error() {
        // MiniMax：正常流的收尾块随附 base_resp.status_code=0，不得误判为错误
        let raw = concat!(
            r#"data: {"id":"m1","choices":[{"index":0,"delta":{"role":"assistant","content":"海螺"}}]}"#, "\n\n",
            r#"data: {"id":"m1","choices":[{"index":0,"delta":{"content":"AI"},"finish_reason":"stop"}],"usage":{"total_tokens":6},"base_resp":{"status_code":0,"status_msg":"success"}}"#, "\n\n",
            "data: [DONE]\n\n",
        );
        let (text, error, done) = replay("openai", raw.as_bytes(), 3);
        assert_eq!(text, "海螺AI");
        assert_eq!(error, None);
        assert!(done);
    }

    #[test]
    fn replay_minimax_http200_error_surfaces() {
        // MiniMax 特色：HTTP 200 + base_resp.status_code 非零表示错误（如 1004 鉴权失败）
        let raw = concat!(
            r#"data: {"base_resp":{"status_code":1004,"status_msg":"invalid api key"}}"#, "\n\n",
        );
        let (text, error, _) = replay("openai", raw.as_bytes(), 9);
        assert_eq!(text, "");
        assert_eq!(error.as_deref(), Some("MiniMax 1004: invalid api key"));
    }

    #[test]
    fn replay_openai_instream_error_surfaces() {
        // OpenAI 系偶发：流中途直接给 {"error":{...}}
        let raw = concat!(
            r#"data: {"choices":[{"index":0,"delta":{"content":"前半"}}]}"#, "\n\n",
            r#"data: {"error":{"message":"The server had an error","type":"server_error"}}"#, "\n\n",
        );
        let (text, error, _) = replay("openai", raw.as_bytes(), 6);
        assert_eq!(text, "前半");
        assert_eq!(error.as_deref(), Some("The server had an error"));
    }

    #[test]
    fn extract_openai_delta() {
        // DeepSeek/Kimi/Qwen/GLM/Ollama 同构
        let data = r#"{"choices":[{"delta":{"content":"你好"},"index":0}]}"#;
        assert_eq!(extract_delta("openai", data), Some("你好".into()));
        assert_eq!(extract_delta("openai", r#"{"choices":[{"delta":{}}]}"#), None);
    }

    #[test]
    fn extract_anthropic_delta() {
        let data = r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#;
        assert_eq!(extract_delta("anthropic", data), Some("Hi".into()));
        // 非增量事件（message_start 等）不产出
        assert_eq!(
            extract_delta("anthropic", r#"{"type":"message_start","message":{}}"#),
            None
        );
    }

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            images: None,
        }
    }

    #[test]
    fn request_building_with_images() {
        let client = reqwest::Client::new();
        let mut user = msg("user", "这张图里是什么？");
        user.images = Some(vec![ImageAttachment {
            media_type: "image/png".into(),
            data_b64: "QUJD".into(),
        }]);
        let messages = vec![user];

        let anthropic = ProviderConfig {
            id: "a".into(), protocol: "anthropic".into(),
            base_url: "https://api.anthropic.com".into(), model: "m".into(),
        };
        let req = build_request(&client, &anthropic, &None, &messages, &None, &None).build().unwrap();
        let body: serde_json::Value = serde_json::from_slice(req.body().unwrap().as_bytes().unwrap()).unwrap();
        // 图片块在前、文本在后
        assert_eq!(body["messages"][0]["content"][0]["type"], "image");
        assert_eq!(body["messages"][0]["content"][0]["source"]["media_type"], "image/png");
        assert_eq!(body["messages"][0]["content"][0]["source"]["data"], "QUJD");
        assert_eq!(body["messages"][0]["content"][1]["type"], "text");

        let openai = ProviderConfig {
            id: "o".into(), protocol: "openai".into(),
            base_url: "https://api.moonshot.cn/v1".into(), model: "m".into(),
        };
        let req = build_request(&client, &openai, &None, &messages, &None, &None).build().unwrap();
        let body: serde_json::Value = serde_json::from_slice(req.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["messages"][0]["content"][0]["type"], "image_url");
        assert_eq!(
            body["messages"][0]["content"][0]["image_url"]["url"],
            "data:image/png;base64,QUJD"
        );
        assert_eq!(body["messages"][0]["content"][1]["text"], "这张图里是什么？");
    }

    #[test]
    fn request_building_per_protocol() {
        let client = reqwest::Client::new();
        let messages = vec![msg("user", "hi")];
        let system = Some("sys".to_string());

        let anthropic = ProviderConfig {
            id: "a".into(), protocol: "anthropic".into(),
            base_url: "https://api.anthropic.com/".into(), model: "claude-sonnet-5".into(),
        };
        let req = build_request(&client, &anthropic, &system, &messages, &None, &Some("K".into()))
            .build().unwrap();
        assert_eq!(req.url().as_str(), "https://api.anthropic.com/v1/messages");
        assert_eq!(req.headers().get("x-api-key").unwrap(), "K");
        assert!(req.headers().get("anthropic-version").is_some());

        let openai = ProviderConfig {
            id: "d".into(), protocol: "openai".into(),
            base_url: "https://api.deepseek.com".into(), model: "deepseek-chat".into(),
        };
        let req = build_request(&client, &openai, &system, &messages, &None, &Some("K".into()))
            .build().unwrap();
        assert_eq!(req.url().as_str(), "https://api.deepseek.com/chat/completions");
        assert!(req.headers().get("authorization").unwrap().to_str().unwrap().starts_with("Bearer "));
        let body = String::from_utf8(req.body().unwrap().as_bytes().unwrap().to_vec()).unwrap();
        assert!(body.contains("\"role\":\"system\""));
        // 未下发工具时不携带 tools 字段
        assert!(!body.contains("\"tools\""));
    }

    // ---- 工具调用（P1）：流式解析与请求映射 ----

    #[test]
    fn replay_anthropic_tool_use_stream() {
        // 文本先行 + tool_use 块（input_json_delta 分片）+ stop_reason=tool_use
        let raw = concat!(
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我先看下目录。"}}"#, "\n\n",
            r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"list_files"}}"#, "\n\n",
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"dir\":\"会议"}}"#, "\n\n",
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"记录\"}"}}"#, "\n\n",
            r#"data: {"type":"content_block_stop","index":1}"#, "\n\n",
            r#"data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}"#, "\n\n",
            r#"data: {"type":"message_stop"}"#, "\n\n",
        );
        let (text, error, _, calls) = replay_full("anthropic", raw.as_bytes(), 3);
        assert_eq!(text, "我先看下目录。");
        assert_eq!(error, None);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "tu_1");
        assert_eq!(calls[0].name, "list_files");
        assert_eq!(calls[0].arguments, r#"{"dir":"会议记录"}"#);
    }

    #[test]
    fn replay_openai_tool_calls_stream() {
        // 双工具并行：按 index 归并、arguments 跨行拼接、finish_reason=tool_calls 停止
        let raw = concat!(
            r#"data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"c_a","function":{"name":"read_doc","arguments":""}}]}}]}"#, "\n\n",
            r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]}}]}"#, "\n\n",
            r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.md\"}"}},{"index":1,"id":"c_b","function":{"name":"search_text","arguments":"{\"query\":\"发布\"}"}}]}}]}"#, "\n\n",
            r#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#, "\n\n",
            "data: [DONE]\n\n",
        );
        let (text, error, done, calls) = replay_full("openai", raw.as_bytes(), 4);
        assert_eq!(text, "");
        assert_eq!(error, None);
        assert!(done);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].id, "c_a");
        assert_eq!(calls[0].arguments, r#"{"path":"a.md"}"#);
        assert_eq!(calls[1].name, "search_text");
    }

    #[test]
    fn replay_openai_tool_calls_flushed_on_done_without_finish_reason() {
        // 个别端点不发 finish_reason=tool_calls：[DONE] 前兜底 flush，且只产出一次
        let raw = concat!(
            r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"list_files","arguments":"{}"}}]}}]}"#, "\n\n",
            "data: [DONE]\n\n",
        );
        let (_, error, done, calls) = replay_full("openai", raw.as_bytes(), 6);
        assert_eq!(error, None);
        assert!(done);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "list_files");
    }

    #[test]
    fn request_building_with_tools_and_history() {
        let client = reqwest::Client::new();
        let tools = Some(vec![ToolDef {
            name: "read_doc".into(),
            description: "读文档".into(),
            parameters: serde_json::json!({"type":"object","properties":{"path":{"type":"string"}}}),
        }]);
        // 历史：assistant 发起两个调用 → 两条 tool 结果（Anthropic 侧必须合并进一条 user 消息）
        let mut assistant = msg("assistant", "查一下");
        assistant.tool_calls = Some(vec![
            ToolCallMsg { id: "t1".into(), name: "read_doc".into(), arguments: r#"{"path":"a.md"}"#.into() },
            ToolCallMsg { id: "t2".into(), name: "read_doc".into(), arguments: r#"{"path":"b.md"}"#.into() },
        ]);
        let mut r1 = msg("tool", "A 内容");
        r1.tool_call_id = Some("t1".into());
        let mut r2 = msg("tool", "B 内容");
        r2.tool_call_id = Some("t2".into());
        let messages = vec![msg("user", "对比 a 和 b"), assistant, r1, r2];

        let anthropic = ProviderConfig {
            id: "a".into(), protocol: "anthropic".into(),
            base_url: "https://api.anthropic.com".into(), model: "m".into(),
        };
        let req = build_request(&client, &anthropic, &None, &messages, &tools, &None).build().unwrap();
        let body: serde_json::Value = serde_json::from_slice(req.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["tools"][0]["name"], "read_doc");
        assert!(body["tools"][0]["input_schema"].is_object());
        // user / assistant(tool_use×2) / user(tool_result×2 合并)
        assert_eq!(body["messages"].as_array().unwrap().len(), 3);
        assert_eq!(body["messages"][1]["content"][1]["type"], "tool_use");
        assert_eq!(body["messages"][1]["content"][1]["input"]["path"], "a.md");
        assert_eq!(body["messages"][2]["role"], "user");
        assert_eq!(body["messages"][2]["content"].as_array().unwrap().len(), 2);
        assert_eq!(body["messages"][2]["content"][0]["type"], "tool_result");
        assert_eq!(body["messages"][2]["content"][0]["tool_use_id"], "t1");

        let openai = ProviderConfig {
            id: "o".into(), protocol: "openai".into(),
            base_url: "https://api.deepseek.com".into(), model: "m".into(),
        };
        let req = build_request(&client, &openai, &None, &messages, &tools, &None).build().unwrap();
        let body: serde_json::Value = serde_json::from_slice(req.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "read_doc");
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[1]["tool_calls"][1]["id"], "t2");
        assert_eq!(msgs[2]["role"], "tool");
        assert_eq!(msgs[2]["tool_call_id"], "t1");
    }
}
