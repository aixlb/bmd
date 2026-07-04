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

// ---- SSE 解析（纯函数，单测覆盖） ----

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
        _ => v["choices"][0]["delta"]["content"].as_str().map(str::to_string),
    }
}

/// 从行缓冲中吐出完整的 "data:" 载荷（跨 chunk 断行安全）
pub fn drain_sse_lines(buf: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(pos) = buf.find('\n') {
        let line: String = buf.drain(..=pos).collect();
        let line = line.trim_end();
        if let Some(data) = line.strip_prefix("data:") {
            out.push(data.trim().to_string());
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
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        if cancels().lock().unwrap().remove(&request_id) {
            return Ok(());
        }
        let chunk = chunk.map_err(err)?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        for data in drain_sse_lines(&mut buf) {
            if data == "[DONE]" {
                let _ = on_event.send(AiEvent::Done);
                return Ok(());
            }
            if let Some(text) = extract_delta(&provider.protocol, &data) {
                if on_event.send(AiEvent::Delta { text }).is_err() {
                    return Ok(());
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
        let mut buf = String::new();
        buf.push_str("data: {\"a\":1}\n\ndata: par");
        assert_eq!(drain_sse_lines(&mut buf), vec!["{\"a\":1}"]);
        assert_eq!(buf, "data: par");
        buf.push_str("tial\n");
        assert_eq!(drain_sse_lines(&mut buf), vec!["partial"]);
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
