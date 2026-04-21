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

pub struct IntentQueue {
    tx: mpsc::UnboundedSender<WriteIntent>,
}

impl IntentQueue {
    pub fn new() -> (Self, Arc<Mutex<mpsc::UnboundedReceiver<WriteIntent>>>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx }, Arc::new(Mutex::new(rx)))
    }

    pub async fn submit_save(&self, content: String, path: PathBuf, generation_id: u64) -> Result<WriteAck, String> {
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

    pub async fn submit_import(&self, content: String, path: PathBuf, generation_id: u64) -> Result<WriteAck, String> {
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
            let current = &owned_batch[i];
            match current {
                WriteIntent::Save { .. } => {
                    let mut j = i + 1;
                    while j < len {
                        match &owned_batch[j] {
                            WriteIntent::Save { .. } => j += 1,
                            _ => break,
                        }
                    }
                    
                    let last_save_idx = j - 1;
                    let mut save_success = true;
                    let mut save_error: Option<String> = None;
                    let mut save_io_duration_ms: u64 = 0;
                    let mut save_retries: u32 = 0;
                    
                    // Execute the last save in the batch
                    let intent = &mut owned_batch[last_save_idx];
                    if let WriteIntent::Save { content, path, generation_id, ack } = intent {
                        let c = std::mem::take(content);
                        let p = path.clone();
                        let g = *generation_id;
                        let (res, io_duration_ms, retries) = Self::write_content(p, c).await;
                        save_success = res.is_ok();
                        save_error = res.err();
                        save_io_duration_ms = io_duration_ms;
                        save_retries = retries;
                         
                        let ack_tx = std::mem::replace(ack, oneshot::channel().0);
                        let _ = ack_tx.send(WriteAck {
                            generation_id: g,
                            success: save_success,
                            error: save_error.clone(),
                            io_duration_ms: save_io_duration_ms,
                            retries: save_retries,
                        });
                    }
                     
                    // Acknowledge all others with the result of the last save
                    for k in i..last_save_idx {
                        if let WriteIntent::Save { generation_id, ack, .. } = &mut owned_batch[k] {
                            let g = *generation_id;
                            let ack_tx = std::mem::replace(ack, oneshot::channel().0);
                            let _ = ack_tx.send(WriteAck {
                                generation_id: g,
                                success: save_success,
                                error: save_error.clone(),
                                io_duration_ms: save_io_duration_ms,
                                retries: save_retries,
                            });
                        }
                    }
                    
                    i = j;
                }
                _ => {
                    match &mut owned_batch[i] {
                        WriteIntent::Import { content, path, generation_id, ack } => {
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
                        WriteIntent::Restore { content, path, generation_id, ack } => {
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
                        _ => unreachable!()
                    }
                    i += 1;
                }
            }
        }
    }

    async fn write_content(path: PathBuf, content: String) -> (Result<(), String>, u64, u32) {
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

        if let Err(e) = tokio::fs::create_dir_all(parent).await {
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
                tokio::time::sleep(delay).await;
                if attempt == max_retries - 1 {
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

        let mut file = match std::fs::File::create(&tmp_path) {
            Ok(f) => f,
            Err(e) => {
                drop(lock_file);
                return (Err(e.to_string()), 0, retries);
            }
        };
        if let Err(e) = file.write_all(content.as_bytes()) {
            drop(lock_file);
            return (Err(e.to_string()), 0, retries);
        }
        if let Err(e) = file.sync_all() {
            drop(lock_file);
            return (Err(e.to_string()), 0, retries);
        }

        if let Err(e) = std::fs::rename(&tmp_path, &path) {
            drop(lock_file);
            return (Err(e.to_string()), 0, retries);
        }

        let io_duration_ms = io_start.elapsed().as_millis() as u64;

        drop(lock_file);
        (Ok(()), io_duration_ms, retries)
    }

    async fn atomic_import(path: PathBuf, content: String) -> Result<(), String> {
        let bak_path = path.with_extension("bak");

        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            tokio::fs::copy(&path, &bak_path).await.map_err(|e| e.to_string())?;
        }

        let (res, _, _) = Self::write_content(path, content).await;
        res
    }

    async fn atomic_restore(path: PathBuf, content: String) -> Result<(), String> {
        let (res, _, _) = Self::write_content(path, content).await;
        res
    }
}
