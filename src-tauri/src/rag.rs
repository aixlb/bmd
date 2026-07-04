use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

// 工作区 RAG（DESIGN.md §13.2）：
// 标题感知分块 → SQLite 存储 → 嵌入（OpenAI 兼容 /embeddings，可选）
// → 暴力余弦检索；未配置嵌入时退化为字符 bigram BM25（中文免分词）。

const CHUNK_TARGET_CHARS: usize = 1000;
const EMBED_BATCH: usize = 32;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedConfig {
    /// keyring 里的 key 归属（复用聊天 provider 的 id）
    pub provider_id: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub files: usize,
    pub chunks: usize,
    pub embedded: usize,
    pub skipped: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RagHit {
    pub path: String,
    pub heading: String,
    pub snippet: String,
    pub score: f32,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---- 分块（纯函数，可测） ----

#[derive(Debug, PartialEq)]
pub struct Chunk {
    pub heading: String,
    pub text: String,
}

pub fn chunk_markdown(src: &str) -> Vec<Chunk> {
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut heading_stack: Vec<(usize, String)> = Vec::new();
    let mut buf = String::new();

    let heading_path = |stack: &[(usize, String)]| {
        stack
            .iter()
            .map(|(_, t)| t.as_str())
            .collect::<Vec<_>>()
            .join(" › ")
    };

    let mut current_heading = String::new();
    let flush = |chunks: &mut Vec<Chunk>, buf: &mut String, heading: &str| {
        let text = buf.trim();
        if !text.is_empty() {
            chunks.push(Chunk {
                heading: heading.to_string(),
                text: text.to_string(),
            });
        }
        buf.clear();
    };

    for line in src.lines() {
        if let Some(m) = regex_heading(line) {
            // 新标题：先落上一块
            flush(&mut chunks, &mut buf, &current_heading);
            let (level, title) = m;
            while heading_stack.last().is_some_and(|(l, _)| *l >= level) {
                heading_stack.pop();
            }
            heading_stack.push((level, title));
            current_heading = heading_path(&heading_stack);
            continue;
        }
        buf.push_str(line);
        buf.push('\n');
        // 超过目标块大小且处于空行边界 → 落块
        if buf.chars().count() >= CHUNK_TARGET_CHARS && line.trim().is_empty() {
            flush(&mut chunks, &mut buf, &current_heading);
        }
        // 极端超长（无空行）强制切
        if buf.chars().count() >= CHUNK_TARGET_CHARS * 2 {
            flush(&mut chunks, &mut buf, &current_heading);
        }
    }
    flush(&mut chunks, &mut buf, &current_heading);
    chunks
}

fn regex_heading(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start();
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &trimmed[hashes..];
    if !rest.starts_with(' ') {
        return None;
    }
    Some((hashes, rest.trim().trim_end_matches('#').trim().to_string()))
}

// ---- 词元化与 BM25（纯函数，可测） ----

/// CJK 按字符 bigram，ASCII 按小写单词
pub fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    let mut prev_cjk: Option<char> = None;
    for ch in text.chars() {
        let is_cjk = ('\u{4e00}'..='\u{9fff}').contains(&ch);
        if is_cjk {
            if !word.is_empty() {
                tokens.push(word.to_lowercase());
                word.clear();
            }
            if let Some(p) = prev_cjk {
                tokens.push(format!("{p}{ch}"));
            }
            tokens.push(ch.to_string());
            prev_cjk = Some(ch);
        } else {
            prev_cjk = None;
            if ch.is_alphanumeric() {
                word.push(ch);
            } else if !word.is_empty() {
                tokens.push(word.to_lowercase());
                word.clear();
            }
        }
    }
    if !word.is_empty() {
        tokens.push(word.to_lowercase());
    }
    tokens
}

pub fn bm25_rank(query: &str, docs: &[&str], k: usize) -> Vec<(usize, f32)> {
    const K1: f32 = 1.5;
    const B: f32 = 0.75;
    let q_tokens = tokenize(query);
    if q_tokens.is_empty() || docs.is_empty() {
        return Vec::new();
    }
    let doc_tokens: Vec<Vec<String>> = docs.iter().map(|d| tokenize(d)).collect();
    let avg_len =
        doc_tokens.iter().map(|t| t.len()).sum::<usize>() as f32 / doc_tokens.len() as f32;
    // 文档频率
    let mut df: HashMap<&str, usize> = HashMap::new();
    for tokens in &doc_tokens {
        let mut seen: Vec<&str> = Vec::new();
        for t in tokens {
            if !seen.contains(&t.as_str()) {
                seen.push(t);
                *df.entry(t).or_default() += 1;
            }
        }
    }
    let n = docs.len() as f32;
    let mut scores: Vec<(usize, f32)> = doc_tokens
        .iter()
        .enumerate()
        .map(|(i, tokens)| {
            let len = tokens.len() as f32;
            let mut tf: HashMap<&str, usize> = HashMap::new();
            for t in tokens {
                *tf.entry(t).or_default() += 1;
            }
            let score: f32 = q_tokens
                .iter()
                .map(|q| {
                    let f = *tf.get(q.as_str()).unwrap_or(&0) as f32;
                    if f == 0.0 {
                        return 0.0;
                    }
                    let d = *df.get(q.as_str()).unwrap_or(&0) as f32;
                    let idf = ((n - d + 0.5) / (d + 0.5) + 1.0).ln();
                    idf * (f * (K1 + 1.0)) / (f + K1 * (1.0 - B + B * len / avg_len.max(1.0)))
                })
                .sum();
            (i, score)
        })
        .filter(|(_, s)| *s > 0.0)
        .collect();
    scores.sort_by(|a, b| b.1.total_cmp(&a.1));
    scores.truncate(k);
    scores
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

fn blob_to_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

// ---- 存储 ----

fn db_path(app: &tauri::AppHandle, workspace: &str) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    workspace.hash(&mut h);
    let dir = app.path().app_data_dir().map_err(err)?.join("rag");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join(format!("{:x}.db", h.finish())))
}

fn open_db(path: &PathBuf) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(path).map_err(err)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, hash TEXT);
         CREATE TABLE IF NOT EXISTS chunks (
           id INTEGER PRIMARY KEY,
           path TEXT, heading TEXT, text TEXT, vec BLOB,
           FOREIGN KEY(path) REFERENCES files(path)
         );
         CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);",
    )
    .map_err(err)?;
    Ok(conn)
}

fn collect_md_files(root: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if matches!(
                p.extension().and_then(|x| x.to_str()),
                Some("md") | Some("markdown")
            ) {
                out.push(p);
            }
        }
        if out.len() > 5000 {
            break;
        }
    }
    out
}

async fn embed_texts(cfg: &EmbedConfig, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    let key = keyring::Entry::new("bmd", &cfg.provider_id)
        .ok()
        .and_then(|e| e.get_password().ok());
    let client = reqwest::Client::new();
    let mut req = client
        .post(format!(
            "{}/embeddings",
            cfg.base_url.trim_end_matches('/')
        ))
        .json(&serde_json::json!({ "model": cfg.model, "input": texts }));
    if let Some(k) = key {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.map_err(err)?;
    if !resp.status().is_success() {
        return Err(format!("嵌入请求失败 HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(err)?;
    let data = v["data"].as_array().ok_or("嵌入响应缺少 data")?;
    data.iter()
        .map(|d| {
            d["embedding"]
                .as_array()
                .ok_or_else(|| "缺少 embedding".to_string())
                .map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect())
        })
        .collect()
}

// rusqlite Connection 非 Send，不能跨 await 持有（tauri 异步命令约束）——
// 所有 DB 操作封装为短生命周期连接的同步函数，await 点之间不携带连接。

fn read_file_hash(db: &PathBuf, path: &str) -> Result<Option<String>, String> {
    let conn = open_db(db)?;
    Ok(conn
        .query_row("SELECT hash FROM files WHERE path = ?1", [path], |r| r.get(0))
        .ok())
}

fn write_file_chunks(
    db: &PathBuf,
    path: &str,
    hash: &str,
    chunks: &[Chunk],
    vectors: &Option<Vec<Vec<f32>>>,
) -> Result<usize, String> {
    let conn = open_db(db)?;
    conn.execute("DELETE FROM chunks WHERE path = ?1", [path]).map_err(err)?;
    conn.execute(
        "INSERT INTO files(path, hash) VALUES(?1, ?2)
         ON CONFLICT(path) DO UPDATE SET hash = ?2",
        [path, hash],
    )
    .map_err(err)?;
    let mut embedded = 0;
    for (i, c) in chunks.iter().enumerate() {
        let vec_blob = vectors.as_ref().and_then(|vs| vs.get(i)).map(|v| vec_to_blob(v));
        if vec_blob.is_some() {
            embedded += 1;
        }
        conn.execute(
            "INSERT INTO chunks(path, heading, text, vec) VALUES(?1, ?2, ?3, ?4)",
            rusqlite::params![path, c.heading, c.text, vec_blob],
        )
        .map_err(err)?;
    }
    Ok(embedded)
}

type ChunkRow = (String, String, String, Option<Vec<u8>>);

fn read_all_chunks(db: &PathBuf) -> Result<Vec<ChunkRow>, String> {
    let conn = open_db(db)?;
    let mut stmt = conn
        .prepare("SELECT path, heading, text, vec FROM chunks")
        .map_err(err)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(err)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

#[tauri::command]
pub async fn rag_index(
    app: tauri::AppHandle,
    workspace: String,
    embed: Option<EmbedConfig>,
) -> Result<IndexStats, String> {
    let db = db_path(&app, &workspace)?;
    open_db(&db)?; // 确保建表
    let files = collect_md_files(&workspace);
    let mut stats = IndexStats { files: files.len(), chunks: 0, embedded: 0, skipped: 0 };

    for file in files {
        let Ok(content) = std::fs::read_to_string(&file) else { continue };
        let path = file.to_string_lossy().into_owned();
        let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
        if read_file_hash(&db, &path)?.as_deref() == Some(hash.as_str()) {
            stats.skipped += 1;
            continue;
        }
        let chunks = chunk_markdown(&content);
        // 嵌入（可选，失败退化为纯文本块 → BM25 兜底）
        let mut vectors: Option<Vec<Vec<f32>>> = None;
        if let Some(cfg) = &embed {
            let mut all: Vec<Vec<f32>> = Vec::with_capacity(chunks.len());
            let mut ok = true;
            for batch in chunks.chunks(EMBED_BATCH) {
                let texts: Vec<String> =
                    batch.iter().map(|c| format!("{}\n{}", c.heading, c.text)).collect();
                match embed_texts(cfg, &texts).await {
                    Ok(vs) => all.extend(vs),
                    Err(_) => {
                        ok = false;
                        break;
                    }
                }
            }
            if ok {
                vectors = Some(all);
            }
        }
        stats.embedded += write_file_chunks(&db, &path, &hash, &chunks, &vectors)?;
        stats.chunks += chunks.len();
    }
    Ok(stats)
}

#[tauri::command]
pub async fn rag_search(
    app: tauri::AppHandle,
    workspace: String,
    query: String,
    embed: Option<EmbedConfig>,
    k: usize,
) -> Result<Vec<RagHit>, String> {
    let db = db_path(&app, &workspace)?;
    let rows = read_all_chunks(&db)?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let k = k.clamp(1, 20);
    let snippet = |text: &str| text.chars().take(600).collect::<String>();

    // 语义检索：有嵌入配置且库内有向量
    if let Some(cfg) = &embed {
        let with_vec: Vec<&ChunkRow> = rows.iter().filter(|r| r.3.is_some()).collect();
        if !with_vec.is_empty() {
            if let Ok(qv) = embed_texts(cfg, &[query.clone()]).await {
                let qv = &qv[0];
                let mut scored: Vec<(usize, f32)> = with_vec
                    .iter()
                    .enumerate()
                    .map(|(i, r)| (i, cosine(qv, &blob_to_vec(r.3.as_ref().unwrap()))))
                    .filter(|(_, s)| *s > 0.25)
                    .collect();
                scored.sort_by(|a, b| b.1.total_cmp(&a.1));
                return Ok(scored
                    .into_iter()
                    .take(k)
                    .map(|(i, s)| RagHit {
                        path: with_vec[i].0.clone(),
                        heading: with_vec[i].1.clone(),
                        snippet: snippet(&with_vec[i].2),
                        score: s,
                    })
                    .collect());
            }
        }
    }

    // BM25 兜底
    let docs: Vec<&str> = rows.iter().map(|r| r.2.as_str()).collect();
    Ok(bm25_rank(&query, &docs, k)
        .into_iter()
        .map(|(i, s)| RagHit {
            path: rows[i].0.clone(),
            heading: rows[i].1.clone(),
            snippet: snippet(&rows[i].2),
            score: s,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunker_splits_by_heading_and_records_path() {
        let md = "# 一\n\n甲段。\n\n## 二\n\n乙段。\n";
        let chunks = chunk_markdown(md);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].heading, "一");
        assert_eq!(chunks[0].text, "甲段。");
        assert_eq!(chunks[1].heading, "一 › 二");
        assert_eq!(chunks[1].text, "乙段。");
    }

    #[test]
    fn chunker_respects_size_bound() {
        // 段落超过目标块大小时在空行边界落块
        let long = format!("# T\n\n{}\n\n{}\n", "字".repeat(1100), "词".repeat(1100));
        let chunks = chunk_markdown(&long);
        assert!(chunks.len() >= 2, "应在空行边界切成多块，实际 {}", chunks.len());
        assert!(chunks.iter().all(|c| c.text.chars().count() <= CHUNK_TARGET_CHARS * 2 + 2));
    }

    #[test]
    fn tokenizer_handles_cjk_bigrams_and_ascii_words() {
        let tokens = tokenize("数据库 rusqlite 很快");
        assert!(tokens.contains(&"数据".to_string()));
        assert!(tokens.contains(&"据库".to_string()));
        assert!(tokens.contains(&"rusqlite".to_string()));
    }

    #[test]
    fn bm25_ranks_relevant_chinese_doc_first() {
        let docs = vec![
            "今天天气很好，适合出门散步。",
            "数据库索引的设计要点：主键、外键与查询计划。",
            "午餐吃了牛肉面。",
        ];
        let ranked = bm25_rank("数据库索引怎么设计", &docs.iter().map(|s| *s).collect::<Vec<_>>(), 3);
        assert_eq!(ranked[0].0, 1);
    }

    #[test]
    fn cosine_sanity() {
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
        assert_eq!(cosine(&[0.0], &[0.0]), 0.0);
    }

    #[test]
    fn vec_blob_roundtrip() {
        let v = vec![0.1f32, -2.5, 3.75];
        assert_eq!(blob_to_vec(&vec_to_blob(&v)), v);
    }
}
