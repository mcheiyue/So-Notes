use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex};

#[derive(Clone, Debug, Serialize)]
pub struct WriteAck {
    pub generation_id: u64,
    pub result: Result<(), String>,
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

    pub async fn submit_save(&self, content: String, path: PathBuf, generation_id: u64) -> Result<(), String> {
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
            Ok(ack) => ack.result,
            Err(_) => Err("Ack channel closed".to_string()),
        }
    }

    pub async fn submit_import(&self, content: String, path: PathBuf, generation_id: u64) -> Result<(), String> {
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
            Ok(ack) => ack.result,
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
                    let mut save_result = Ok(());
                    
                    // Execute the last save in the batch
                    let intent = &mut owned_batch[last_save_idx];
                    if let WriteIntent::Save { content, path, generation_id, ack } = intent {
                        let c = std::mem::take(content);
                        let p = path.clone();
                        let g = *generation_id;
                        let res = Self::write_content(p, c).await;
                        save_result = res.clone();
                        
                        let ack_tx = std::mem::replace(ack, oneshot::channel().0);
                        let _ = ack_tx.send(WriteAck { generation_id: g, result: res });
                    }
                    
                    // Acknowledge all others with the result of the last save
                    for k in i..last_save_idx {
                        if let WriteIntent::Save { generation_id, ack, .. } = &mut owned_batch[k] {
                            let g = *generation_id;
                            let ack_tx = std::mem::replace(ack, oneshot::channel().0);
                            let _ = ack_tx.send(WriteAck { 
                                generation_id: g, 
                                result: save_result.clone() 
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
                            let _ = ack_tx.send(WriteAck { generation_id: g, result: res });
                        }
                        WriteIntent::Restore { content, path, generation_id, ack } => {
                            let c = std::mem::take(content);
                            let p = path.clone();
                            let g = *generation_id;
                            let res = Self::atomic_restore(p, c).await;
                            let ack_tx = std::mem::replace(ack, oneshot::channel().0);
                            let _ = ack_tx.send(WriteAck { generation_id: g, result: res });
                        }
                        _ => unreachable!()
                    }
                    i += 1;
                }
            }
        }
    }

    async fn write_content(path: PathBuf, content: String) -> Result<(), String> {
        use fs4::fs_std::FileExt;
        use std::fs::OpenOptions;
        use std::io::Write;
        
        let lock_path = path.with_extension("tmp.lock");
        let tmp_path = path.with_extension("tmp");
        let parent = path.parent().ok_or("Invalid path: no parent")?;
        
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        
        let lock_file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|e| format!("Failed to open lock file: {}", e))?;
            
        let max_retries = 8;
        let base_delay_ms = 50;
        for attempt in 0..max_retries {
            if let Err(e) = lock_file.try_lock_exclusive() {
                let jitter = (rand::random::<u64>() % 20) as u64;
                let delay = Duration::from_millis((base_delay_ms * (1 << attempt)) + jitter);
                tokio::time::sleep(delay).await;
                if attempt == max_retries - 1 {
                    return Err(format!("Lock contention exhausted after retries: {}", e));
                }
                continue;
            }
            break;
        }
        
        let mut file = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        
        std::fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;
        
        drop(lock_file);
        Ok(())
    }

    async fn atomic_import(path: PathBuf, content: String) -> Result<(), String> {
        let bak_path = path.with_extension("bak");
        
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            tokio::fs::copy(&path, &bak_path).await.map_err(|e| e.to_string())?;
        }
        
        Self::write_content(path, content).await
    }

    async fn atomic_restore(path: PathBuf, content: String) -> Result<(), String> {
        Self::write_content(path, content).await
    }
}
