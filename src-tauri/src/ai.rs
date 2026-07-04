use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::Manager;

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

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AiEvent {
    Delta { text: String },
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

#[tauri::command]
pub async fn ai_cancel(request_id: String) -> Result<(), String> {
    cancels().lock().unwrap().insert(request_id);
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
    Error(String),
    Done,
}

/// 处理一段新到的字节，按序产出事件
pub fn process_chunk(protocol: &str, buf: &mut Vec<u8>, chunk: &[u8]) -> Vec<SseItem> {
    buf.extend_from_slice(chunk);
    let mut out = Vec::new();
    for data in drain_sse_lines(buf) {
        if data == "[DONE]" {
            out.push(SseItem::Done);
            continue;
        }
        if let Some(m) = extract_error(protocol, &data) {
            out.push(SseItem::Error(m));
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

fn build_request(
    client: &reqwest::Client,
    provider: &ProviderConfig,
    system: &Option<String>,
    messages: &[ChatMessage],
    key: &Option<String>,
) -> reqwest::RequestBuilder {
    let base = provider.base_url.trim_end_matches('/');
    if provider.protocol == "anthropic" {
        let body = serde_json::json!({
            "model": provider.model,
            "max_tokens": 8192,
            "stream": true,
            "system": system.clone().unwrap_or_default(),
            "messages": messages,
        });
        let mut r = client
            .post(format!("{base}/v1/messages"))
            .header("anthropic-version", "2023-06-01")
            .json(&body);
        if let Some(k) = key {
            r = r.header("x-api-key", k);
        }
        r
    } else {
        let mut msgs: Vec<serde_json::Value> = Vec::new();
        if let Some(s) = system {
            msgs.push(serde_json::json!({ "role": "system", "content": s }));
        }
        for m in messages {
            msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
        }
        let body = serde_json::json!({
            "model": provider.model,
            "stream": true,
            "messages": msgs,
        });
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
    on_event: Channel<AiEvent>,
) -> Result<(), String> {
    cancels().lock().unwrap().remove(&request_id);
    let key = get_key(&provider.id);
    let client = reqwest::Client::new();
    let resp = build_request(&client, &provider, &system, &messages, &key)
        .send()
        .await
        .map_err(err)?;

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
    while let Some(chunk) = stream.next().await {
        if cancels().lock().unwrap().remove(&request_id) {
            return Ok(());
        }
        let chunk = chunk.map_err(err)?;
        for item in process_chunk(&provider.protocol, &mut buf, &chunk) {
            match item {
                SseItem::Done => {
                    let _ = on_event.send(AiEvent::Done);
                    return Ok(());
                }
                SseItem::Error(message) => {
                    let _ = on_event.send(AiEvent::Error { message });
                    return Ok(());
                }
                SseItem::Delta(text) => {
                    if on_event.send(AiEvent::Delta { text }).is_err() {
                        return Ok(());
                    }
                }
            }
        }
    }
    let _ = on_event.send(AiEvent::Done);
    Ok(())
}

// ---- 会话持久化（AppData/chats/<hash>.json） ----

fn chats_file(app: &tauri::AppHandle, workspace: &str) -> Result<std::path::PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    workspace.hash(&mut h);
    let dir = app.path().app_data_dir().map_err(err)?.join("chats");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join(format!("{:x}.json", h.finish())))
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
    std::fs::write(&file, json).map_err(err)
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
        let mut buf: Vec<u8> = Vec::new();
        let (mut text, mut error, mut done) = (String::new(), None, false);
        for chunk in raw.chunks(n) {
            for item in process_chunk(protocol, &mut buf, chunk) {
                match item {
                    SseItem::Delta(t) => text.push_str(&t),
                    SseItem::Error(e) => {
                        if error.is_none() {
                            error = Some(e);
                        }
                    }
                    SseItem::Done => done = true,
                }
            }
        }
        (text, error, done)
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

    #[test]
    fn request_building_per_protocol() {
        let client = reqwest::Client::new();
        let messages = vec![ChatMessage { role: "user".into(), content: "hi".into() }];
        let system = Some("sys".to_string());

        let anthropic = ProviderConfig {
            id: "a".into(), protocol: "anthropic".into(),
            base_url: "https://api.anthropic.com/".into(), model: "claude-sonnet-5".into(),
        };
        let req = build_request(&client, &anthropic, &system, &messages, &Some("K".into()))
            .build().unwrap();
        assert_eq!(req.url().as_str(), "https://api.anthropic.com/v1/messages");
        assert_eq!(req.headers().get("x-api-key").unwrap(), "K");
        assert!(req.headers().get("anthropic-version").is_some());

        let openai = ProviderConfig {
            id: "d".into(), protocol: "openai".into(),
            base_url: "https://api.deepseek.com".into(), model: "deepseek-chat".into(),
        };
        let req = build_request(&client, &openai, &system, &messages, &Some("K".into()))
            .build().unwrap();
        assert_eq!(req.url().as_str(), "https://api.deepseek.com/chat/completions");
        assert!(req.headers().get("authorization").unwrap().to_str().unwrap().starts_with("Bearer "));
        let body = String::from_utf8(req.body().unwrap().as_bytes().unwrap().to_vec()).unwrap();
        assert!(body.contains("\"role\":\"system\""));
    }
}
