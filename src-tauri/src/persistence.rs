use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex};

#[derive(Clone, Debug, Serialize)]
pub struct WriteAck {
    pub generation_id: u64,
    pub success: bool,
    pub error: Option<String>,
    pub io_duration_ms: u64,
    pub retries: u32,
}

pub enum WriteIntent {
    Save {
        content: String,
        path: PathBuf,
        generation_id: u64,
        ack: oneshot::Sender<WriteAck>,
    },
    Import {
        content: String,
        path: PathBuf,
        generation_id: u64,
        ack: oneshot::Sender<WriteAck>,
    },
    Restore {
        content: String,
        path: PathBuf,
        generation_id: u64,
        ack: oneshot::Sender<WriteAck>,
    },
}

/// 作用域结束时删除目标文件；显式解除后不再删除。
/// 用于确保临时文件在成功和失败路径上都能被清理。
struct CleanupGuard {
    path: PathBuf,
    armed: bool,
}

impl CleanupGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub struct IntentQueue {
    tx: mpsc::UnboundedSender<WriteIntent>,
}

impl IntentQueue {
    pub fn new() -> (Self, Arc<Mutex<mpsc::UnboundedReceiver<WriteIntent>>>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, Arc::new(Mutex::new(rx)))
    }

    pub async fn submit_save(
        &self,
        content: String,
        path: PathBuf,
        generation_id: u64,
    ) -> Result<WriteAck, String> {
        let (ack_tx, ack_rx) = oneshot::channel();
        self.tx
            .send(WriteIntent::Save {
                content,
                path,
                generation_id,
                ack: ack_tx,
            })
            .map_err(|_| "Queue closed".to_string())?;

        match ack_rx.await {
            Ok(ack) => Ok(ack),
            Err(_) => Err("Ack channel closed".to_string()),
        }
    }

    pub async fn submit_import(
        &self,
        content: String,
        path: PathBuf,
        generation_id: u64,
    ) -> Result<WriteAck, String> {
        let (ack_tx, ack_rx) = oneshot::channel();
        self.tx
            .send(WriteIntent::Import {
                content,
                path,
                generation_id,
                ack: ack_tx,
            })
            .map_err(|_| "Queue closed".to_string())?;

        match ack_rx.await {
            Ok(ack) => Ok(ack),
            Err(_) => Err("Ack channel closed".to_string()),
        }
    }

    pub async fn consumer_loop(rx: Arc<Mutex<mpsc::UnboundedReceiver<WriteIntent>>>) {
        let mut pending_saves: Vec<WriteIntent> = Vec::new();

        loop {
            let first_intent = rx.lock().await.recv().await;
            if first_intent.is_none() {
                break;
            }

            pending_saves.push(first_intent.unwrap());

            {
                let mut lock = rx.lock().await;
                while let Ok(intent) = lock.try_recv() {
                    pending_saves.push(intent);
                }
            }

            Self::process_batch(&mut pending_saves).await;
            pending_saves.clear();
        }
    }

    async fn process_batch(batch: &mut Vec<WriteIntent>) {
        let mut owned_batch = std::mem::take(batch);
        let mut i = 0;
        let len = owned_batch.len();

        while i < len {
            if matches!(&owned_batch[i], WriteIntent::Save { .. }) {
                // 找到连续 Save 区间的结束位置。
                let mut j = i + 1;
                while j < len {
                    if matches!(&owned_batch[j], WriteIntent::Save { .. }) {
                        j += 1;
                    } else {
                        break;
                    }
                }

                // 在 saves[i..j] 内按路径分组。连续同路径 Save 折叠为最新内容；
                // 不同路径必须各自写入。
                let mut k = i;
                while k < j {
                    let group_path = match &owned_batch[k] {
                        WriteIntent::Save { path, .. } => path.clone(),
                        _ => unreachable!(),
                    };

                    // 找到 k..j 内连续同路径区间的结束位置。
                    let mut m = k + 1;
                    while m < j {
                        match &owned_batch[m] {
                            WriteIntent::Save { path, .. } if *path == group_path => m += 1,
                            _ => break,
                        }
                    }

                    // 使用该路径组最后一次 Save 的内容写盘。
                    let last_idx = m - 1;
                    let (content, path, gen_id) = if let WriteIntent::Save {
                        content,
                        path,
                        generation_id,
                        ..
                    } = &mut owned_batch[last_idx]
                    {
                        (std::mem::take(content), path.clone(), *generation_id)
                    } else {
                        unreachable!()
                    };

                    let (res, io_duration_ms, retries) = Self::write_content(path, content).await;
                    let save_success = res.is_ok();
                    let save_error = res.err();

                    // 先确认真正写入内容的最后一次 Save。
                    if let WriteIntent::Save { ack, .. } = &mut owned_batch[last_idx] {
                        let ack_tx = std::mem::replace(ack, oneshot::channel().0);
                        let _ = ack_tx.send(WriteAck {
                            generation_id: gen_id,
                            success: save_success,
                            error: save_error.clone(),
                            io_duration_ms,
                            retries,
                        });
                    }

                    // 早于它的同路径 Save 复用同一写盘结果。
                    for idx in k..last_idx {
                        if let WriteIntent::Save {
                            generation_id, ack, ..
                        } = &mut owned_batch[idx]
                        {
                            let g = *generation_id;
                            let ack_tx = std::mem::replace(ack, oneshot::channel().0);
                            let _ = ack_tx.send(WriteAck {
                                generation_id: g,
                                success: save_success,
                                error: save_error.clone(),
                                io_duration_ms,
                                retries,
                            });
                        }
                    }

                    k = m;
                }

                i = j;
            } else {
                match &mut owned_batch[i] {
                    WriteIntent::Import {
                        content,
                        path,
                        generation_id,
                        ack,
                    } => {
                        let c = std::mem::take(content);
                        let p = path.clone();
                        let g = *generation_id;
                        let res = Self::atomic_import(p, c).await;
                        let ack_tx = std::mem::replace(ack, oneshot::channel().0);
                        let (success, error) = match res {
                            Ok(()) => (true, None),
                            Err(e) => (false, Some(e)),
                        };
                        let _ = ack_tx.send(WriteAck {
                            generation_id: g,
                            success,
                            error,
                            io_duration_ms: 0,
                            retries: 0,
                        });
                    }
                    WriteIntent::Restore {
                        content,
                        path,
                        generation_id,
                        ack,
                    } => {
                        let c = std::mem::take(content);
                        let p = path.clone();
                        let g = *generation_id;
                        let res = Self::atomic_restore(p, c).await;
                        let ack_tx = std::mem::replace(ack, oneshot::channel().0);
                        let (success, error) = match res {
                            Ok(()) => (true, None),
                            Err(e) => (false, Some(e)),
                        };
                        let _ = ack_tx.send(WriteAck {
                            generation_id: g,
                            success,
                            error,
                            io_duration_ms: 0,
                            retries: 0,
                        });
                    }
                    _ => unreachable!(),
                }
                i += 1;
            }
        }
    }

    async fn write_content(path: PathBuf, content: String) -> (Result<(), String>, u64, u32) {
        tokio::task::spawn_blocking(move || Self::write_content_blocking(path, content))
            .await
            .unwrap_or_else(|e| (Err(format!("Blocking write task failed: {}", e)), 0, 0))
    }

    /// 原子写入的同步阻塞主体。
    /// 必须在 `tokio::task::spawn_blocking` 内运行，避免阻塞 async runtime。
    fn write_content_blocking(path: PathBuf, content: String) -> (Result<(), String>, u64, u32) {
        use fs4::fs_std::FileExt;
        use std::fs::OpenOptions;
        use std::io::Write;
        use std::time::Instant;

        let lock_path = path.with_extension("tmp.lock");
        let tmp_path = path.with_extension("tmp");
        let parent = match path.parent() {
            Some(p) => p,
            None => return (Err("Invalid path: no parent".to_string()), 0, 0),
        };

        if let Err(e) = std::fs::create_dir_all(parent) {
            return (Err(e.to_string()), 0, 0);
        }

        let lock_file = match OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&lock_path)
        {
            Ok(f) => f,
            Err(e) => return (Err(format!("Failed to open lock file: {}", e)), 0, 0),
        };

        let max_retries: u32 = 8;
        let base_delay_ms: u64 = 50;
        let mut retries: u32 = 0;
        for attempt in 0..max_retries {
            if let Err(e) = lock_file.try_lock_exclusive() {
                retries += 1;
                let jitter = (rand::random::<u64>() % 20) as u64;
                let delay = Duration::from_millis((base_delay_ms * (1u64 << attempt)) + jitter);
                std::thread::sleep(delay);
                if attempt == max_retries - 1 {
                    drop(lock_file);
                    let _ = std::fs::remove_file(&lock_path);
                    return (
                        Err(format!("Lock contention exhausted after retries: {}", e)),
                        0,
                        retries,
                    );
                }
                continue;
            }
            break;
        }

        let io_start = Instant::now();

        // 任一错误路径都由 guard 清理临时文件。
        let mut tmp_guard = CleanupGuard::new(tmp_path.clone());

        let mut file = match std::fs::File::create(&tmp_path) {
            Ok(f) => f,
            Err(e) => {
                drop(lock_file);
                let _ = std::fs::remove_file(&lock_path);
                return (Err(e.to_string()), 0, retries);
            }
        };
        if let Err(e) = file.write_all(content.as_bytes()) {
            drop(lock_file);
            let _ = std::fs::remove_file(&lock_path);
            return (Err(e.to_string()), 0, retries);
        }
        if let Err(e) = file.sync_all() {
            drop(lock_file);
            let _ = std::fs::remove_file(&lock_path);
            return (Err(e.to_string()), 0, retries);
        }
        drop(file);

        if let Err(e) = std::fs::rename(&tmp_path, &path) {
            drop(lock_file);
            let _ = std::fs::remove_file(&lock_path);
            return (Err(e.to_string()), 0, retries);
        }

        // rename 成功后临时路径已被消耗，不再由 guard 删除。
        tmp_guard.disarm();
        let io_duration_ms = io_start.elapsed().as_millis() as u64;

        drop(lock_file);
        let _ = std::fs::remove_file(&lock_path);
        (Ok(()), io_duration_ms, retries)
    }

    async fn atomic_import(path: PathBuf, content: String) -> Result<(), String> {
        let bak_path = path.with_extension("bak");
        let _bak_guard = if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            tokio::fs::copy(&path, &bak_path)
                .await
                .map_err(|e| e.to_string())?;
            Some(CleanupGuard::new(bak_path))
        } else {
            None
        };

        let (res, _, _) = Self::write_content(path, content).await;
        res
    }

    async fn atomic_restore(path: PathBuf, content: String) -> Result<(), String> {
        let (res, _, _) = Self::write_content(path, content).await;
        res
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    /// 构造 Save intent 及其 ack receiver。
    fn make_save(
        content: &str,
        path: &str,
        gen_id: u64,
    ) -> (WriteIntent, oneshot::Receiver<WriteAck>) {
        let (tx, rx) = oneshot::channel();
        (
            WriteIntent::Save {
                content: content.to_string(),
                path: PathBuf::from(path),
                generation_id: gen_id,
                ack: tx,
            },
            rx,
        )
    }

    /// 为每个测试创建独立临时目录，避免相互污染。
    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sonotes_persist_test_{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    #[test]
    fn different_paths_in_batch_both_get_written() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = test_dir("diff_paths");
            let path_a = dir.join("a.json");
            let path_b = dir.join("b.json");

            let (intent_a, mut rx_a) = make_save("alpha", path_a.to_str().unwrap(), 1);
            let (intent_b, mut rx_b) = make_save("beta", path_b.to_str().unwrap(), 2);

            let mut batch = vec![intent_a, intent_b];
            IntentQueue::process_batch(&mut batch).await;

            let ack_a = rx_a.try_recv().expect("ack for path A");
            let ack_b = rx_b.try_recv().expect("ack for path B");

            assert!(ack_a.success, "path A 保存应成功");
            assert!(ack_b.success, "path B 保存应成功");
            assert_eq!(std::fs::read_to_string(&path_a).unwrap(), "alpha");
            assert_eq!(std::fs::read_to_string(&path_b).unwrap(), "beta");

            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn same_path_saves_fold_to_latest_content() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = test_dir("same_fold");
            let path = dir.join("data.json");

            let (intent_old, mut rx_old) = make_save("old", path.to_str().unwrap(), 1);
            let (intent_new, mut rx_new) = make_save("new", path.to_str().unwrap(), 2);

            let mut batch = vec![intent_old, intent_new];
            IntentQueue::process_batch(&mut batch).await;

            let ack_old = rx_old.try_recv().expect("ack for old save");
            let ack_new = rx_new.try_recv().expect("ack for new save");

            assert!(ack_old.success, "旧 Save ack 应报告成功");
            assert!(ack_new.success, "新 Save ack 应报告成功");
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                "new",
                "文件内容应为最新 Save"
            );

            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn tmp_and_lock_files_cleaned_after_successful_write() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = test_dir("cleanup");
            let path = dir.join("clean.json");

            let (intent, mut rx) = make_save("hello", path.to_str().unwrap(), 1);
            let mut batch = vec![intent];
            IntentQueue::process_batch(&mut batch).await;

            let ack = rx.try_recv().expect("ack");
            assert!(ack.success);

            assert!(path.exists(), "目标文件应存在");

            let tmp_path = path.with_extension("tmp");
            let lock_path = path.with_extension("tmp.lock");
            assert!(!tmp_path.exists(), "临时文件应被清理");
            assert!(!lock_path.exists(), "锁文件应被清理");

            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn atomic_import_removes_bak_after_success() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = test_dir("import_bak_success");
            let path = dir.join("data.json");
            std::fs::write(&path, "old").unwrap();

            IntentQueue::atomic_import(path.clone(), "new".to_string())
                .await
                .unwrap();

            assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
            assert!(!path.with_extension("bak").exists(), ".bak 应在导入成功后清理");

            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn atomic_import_removes_bak_after_write_failure() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = test_dir("import_bak_failure");
            let path = dir.join("data.json");
            std::fs::write(&path, "old").unwrap();
            std::fs::create_dir(path.with_extension("tmp")).unwrap();

            let result = IntentQueue::atomic_import(path.clone(), "new".to_string()).await;

            assert!(result.is_err(), "预置 tmp 目录应导致写入失败");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
            assert!(!path.with_extension("bak").exists(), ".bak 应在导入失败后清理");

            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn invalid_path_does_not_panic() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // 空路径没有父目录，应返回错误而不是 panic。
            let (intent, mut rx) = make_save("data", "", 1);
            let mut batch = vec![intent];
            IntentQueue::process_batch(&mut batch).await;

            let ack = rx.try_recv().expect("ack");
            assert!(!ack.success, "非法路径应失败");
            assert!(ack.error.is_some(), "应返回错误信息");
        });
    }

    #[test]
    fn interleaved_paths_each_written_independently() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = test_dir("interleaved");
            let path_a = dir.join("x.json");
            let path_b = dir.join("y.json");

            // A、B、A 之间被不同路径打断，因此三次 Save 都应独立写入。
            let (a1, mut rx_a1) = make_save("a_v1", path_a.to_str().unwrap(), 1);
            let (b1, mut rx_b1) = make_save("b_v1", path_b.to_str().unwrap(), 2);
            let (a2, mut rx_a2) = make_save("a_v2", path_a.to_str().unwrap(), 3);

            let mut batch = vec![a1, b1, a2];
            IntentQueue::process_batch(&mut batch).await;

            let ack_a1 = rx_a1.try_recv().expect("ack a1");
            let ack_b1 = rx_b1.try_recv().expect("ack b1");
            let ack_a2 = rx_a2.try_recv().expect("ack a2");

            assert!(ack_a1.success);
            assert!(ack_b1.success);
            assert!(ack_a2.success);

            // path_a 先写 a_v1 再写 a_v2，最终内容应为 a_v2。
            assert_eq!(std::fs::read_to_string(&path_a).unwrap(), "a_v2");
            assert_eq!(std::fs::read_to_string(&path_b).unwrap(), "b_v1");

            let _ = std::fs::remove_dir_all(&dir);
        });
    }

    #[test]
    fn consecutive_same_path_fold_while_different_path_written() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let dir = test_dir("mixed_fold");
            let path_a = dir.join("m.json");
            let path_b = dir.join("n.json");

            // A_old、A_new 连续同路径折叠为 A_new；B 独立写入。
            let (a_old, mut rx_a_old) = make_save("old_a", path_a.to_str().unwrap(), 1);
            let (a_new, mut rx_a_new) = make_save("new_a", path_a.to_str().unwrap(), 2);
            let (b1, mut rx_b1) = make_save("b_val", path_b.to_str().unwrap(), 3);

            let mut batch = vec![a_old, a_new, b1];
            IntentQueue::process_batch(&mut batch).await;

            let ack_a_old = rx_a_old.try_recv().expect("ack a_old");
            let ack_a_new = rx_a_new.try_recv().expect("ack a_new");
            let ack_b1 = rx_b1.try_recv().expect("ack b1");

            assert!(ack_a_old.success);
            assert!(ack_a_new.success);
            assert!(ack_b1.success);

            assert_eq!(std::fs::read_to_string(&path_a).unwrap(), "new_a");
            assert_eq!(std::fs::read_to_string(&path_b).unwrap(), "b_val");

            let _ = std::fs::remove_dir_all(&dir);
        });
    }
}
