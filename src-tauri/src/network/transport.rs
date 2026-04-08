use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use chrono::Utc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::time::{timeout, Duration};

use super::discovery::DiscoveredPeer;
use super::protocol::{Message, NoteEnvelope, PeerInfo};
use super::store::RemoteNoteStore;

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SEEN_IDS: usize = 10_000;
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);
const MAX_MSG_SIZE: u32 = 1_024 * 1_024; // 1MB max message

#[allow(dead_code)]
struct Connection {
	writer_tx: mpsc::UnboundedSender<Message>,
	peer_name: String,
}

pub struct TransportHandle {
	node_id: String,
	name: String,
	connections: Arc<Mutex<HashMap<String, Connection>>>,
	store: Arc<RemoteNoteStore>,
	share_tx: mpsc::UnboundedSender<NoteEnvelope>,
	retract_tx: mpsc::UnboundedSender<String>,
	shutdown: Arc<Notify>,
	seen_ids: Arc<Mutex<SeenIdSet>>,
}

/// Bounded FIFO set of seen note IDs for deduplication.
struct SeenIdSet {
	set: HashSet<String>,
	order: VecDeque<String>,
}

impl SeenIdSet {
	fn new() -> Self {
		Self {
			set: HashSet::new(),
			order: VecDeque::new(),
		}
	}

	/// Returns true if the ID was newly inserted (not a duplicate).
	fn insert(&mut self, id: String) -> bool {
		if self.set.contains(&id) {
			return false;
		}
		// Evict oldest if at capacity
		while self.set.len() >= MAX_SEEN_IDS {
			if let Some(old) = self.order.pop_front() {
				self.set.remove(&old);
			}
		}
		self.set.insert(id.clone());
		self.order.push_back(id);
		true
	}
}

impl TransportHandle {
	pub fn share_note(&self, envelope: NoteEnvelope) {
		let _ = self.share_tx.send(envelope);
	}

	pub fn retract_note(&self, note_id: &str) {
		let _ = self.retract_tx.send(note_id.to_string());
	}

	#[allow(dead_code)]
	pub fn shutdown(&self) {
		self.shutdown.notify_waiters();
	}
}

/// Encode a message as length-prefixed JSON (4-byte LE u32 + JSON bytes).
fn encode_message(msg: &Message) -> Result<Vec<u8>, String> {
	let json = serde_json::to_vec(msg).map_err(|e| format!("serialize: {e}"))?;
	let len = json.len() as u32;
	let mut buf = Vec::with_capacity(4 + json.len());
	buf.extend_from_slice(&len.to_le_bytes());
	buf.extend_from_slice(&json);
	Ok(buf)
}

/// Read one length-prefixed JSON message from a stream.
async fn read_message(stream: &mut TcpStream) -> Result<Message, String> {
	let mut len_buf = [0u8; 4];
	stream
		.read_exact(&mut len_buf)
		.await
		.map_err(|e| format!("read len: {e}"))?;
	let len = u32::from_le_bytes(len_buf);

	if len > MAX_MSG_SIZE {
		return Err(format!("message too large: {len} bytes"));
	}

	let mut buf = vec![0u8; len as usize];
	stream
		.read_exact(&mut buf)
		.await
		.map_err(|e| format!("read body: {e}"))?;

	serde_json::from_slice(&buf).map_err(|e| format!("deserialize: {e}"))
}

/// Write one length-prefixed JSON message to a stream.
async fn write_message(stream: &mut TcpStream, msg: &Message) -> Result<(), String> {
	let data = encode_message(msg)?;
	stream
		.write_all(&data)
		.await
		.map_err(|e| format!("write: {e}"))?;
	stream.flush().await.map_err(|e| format!("flush: {e}"))?;
	Ok(())
}

/// Start the transport layer: TCP listener + connection management.
///
/// Returns the bound port and the transport handle.
pub async fn start_transport(
	node_id: String,
	name: String,
	store: Arc<RemoteNoteStore>,
) -> Result<(u16, Arc<TransportHandle>), String> {
	let listener = TcpListener::bind("0.0.0.0:0")
		.await
		.map_err(|e| format!("Failed to bind TCP: {e}"))?;

	let port = listener
		.local_addr()
		.map_err(|e| format!("Failed to get local addr: {e}"))?
		.port();

	crate::log(&format!("[network] TCP listener bound on port {port}"));

	let (share_tx, share_rx) = mpsc::unbounded_channel::<NoteEnvelope>();
	let (retract_tx, retract_rx) = mpsc::unbounded_channel::<String>();
	let shutdown = Arc::new(Notify::new());

	let handle = Arc::new(TransportHandle {
		node_id: node_id.clone(),
		name: name.clone(),
		connections: Arc::new(Mutex::new(HashMap::new())),
		store: store.clone(),
		share_tx,
		retract_tx,
		shutdown: shutdown.clone(),
		seen_ids: Arc::new(Mutex::new(SeenIdSet::new())),
	});

	// Spawn the TCP accept loop
	let accept_handle = handle.clone();
	tokio::spawn(async move {
		accept_loop(listener, accept_handle).await;
	});

	// Spawn the broadcast loop for shared notes
	let broadcast_handle = handle.clone();
	tokio::spawn(async move {
		broadcast_loop(share_rx, broadcast_handle).await;
	});

	// Spawn the retract broadcast loop
	let retract_handle = handle.clone();
	tokio::spawn(async move {
		retract_loop(retract_rx, retract_handle).await;
	});

	// Spawn heartbeat loop
	let heartbeat_handle = handle.clone();
	let heartbeat_shutdown = shutdown.clone();
	tokio::spawn(async move {
		heartbeat_loop(heartbeat_handle, heartbeat_shutdown).await;
	});

	Ok((port, handle))
}

/// Accept incoming TCP connections.
async fn accept_loop(listener: TcpListener, handle: Arc<TransportHandle>) {
	loop {
		tokio::select! {
			result = listener.accept() => {
				match result {
					Ok((stream, addr)) => {
						crate::log(&format!("[network] Incoming connection from {addr}"));
						let h = handle.clone();
						tokio::spawn(async move {
							handle_inbound(stream, h).await;
						});
					}
					Err(e) => {
						eprintln!("[network/transport] Accept error: {e}");
					}
				}
			}
			_ = handle.shutdown.notified() => {
				eprintln!("[network/transport] Shutting down accept loop");
				return;
			}
		}
	}
}

/// Handle an inbound TCP connection (they connected to us).
async fn handle_inbound(mut stream: TcpStream, handle: Arc<TransportHandle>) {
	// Expect Hello first
	let hello = match timeout(CONNECT_TIMEOUT, read_message(&mut stream)).await {
		Ok(Ok(msg)) => msg,
		Ok(Err(e)) => {
			eprintln!("[network/transport] Inbound read error: {e}");
			return;
		}
		Err(_) => {
			eprintln!("[network/transport] Inbound hello timeout");
			return;
		}
	};

	let (peer_node_id, peer_name) = match &hello {
		Message::Hello {
			node_id, name, ..
		} => (node_id.clone(), name.clone()),
		_ => {
			eprintln!("[network/transport] Expected Hello, got something else");
			return;
		}
	};

	// Duplicate connection resolution: lower node_id keeps outbound
	// Since this is inbound, we are the "server" side. If our node_id < peer's,
	// the peer should keep their outbound (this inbound), so we accept.
	// If our node_id > peer's, we should keep our outbound if it exists.
	{
		let conns = handle.connections.lock().await;
		if conns.contains_key(&peer_node_id) {
			if handle.node_id > peer_node_id {
				// We have higher ID, peer has lower. The peer keeps outbound.
				// This means our existing outbound should be dropped, accept this inbound.
				// Drop lock first, then remove.
				drop(conns);
				handle.connections.lock().await.remove(&peer_node_id);
			} else {
				// We have lower ID, we keep our outbound. Drop this inbound.
				eprintln!(
					"[network/transport] Dropping duplicate inbound from {} (we keep outbound)",
					peer_node_id
				);
				return;
			}
		}
	}

	// Send our Hello back
	if let Err(e) = write_message(
		&mut stream,
		&Message::Hello {
			node_id: handle.node_id.clone(),
			name: handle.name.clone(),
			version: 1,
		},
	)
	.await
	{
		eprintln!("[network/transport] Failed to send Hello: {e}");
		return;
	}

	// Send sync of our shared notes (if any from store — these are notes we've shared)
	// For inbound connections, we send a sync with remote notes we have
	let all_notes = handle.store.get_all();
	if !all_notes.is_empty() {
		if let Err(e) = write_message(&mut stream, &Message::Sync { notes: all_notes }).await {
			eprintln!("[network/transport] Failed to send Sync: {e}");
			return;
		}
	}

	// Register peer
	handle.store.upsert_peer(PeerInfo {
		node_id: peer_node_id.clone(),
		name: peer_name.clone(),
		addr: stream
			.peer_addr()
			.map(|a| a.to_string())
			.unwrap_or_default(),
		connected_at: Utc::now().to_rfc3339(),
		last_seen: Utc::now().to_rfc3339(),
	});

	run_connection(stream, peer_node_id, peer_name, handle).await;
}

/// Connect outbound to a discovered peer.
pub async fn connect_to_peer(peer: DiscoveredPeer, handle: Arc<TransportHandle>) {
	let mut delay = Duration::from_secs(1);

	loop {
		// Check if we already have a connection
		{
			let conns = handle.connections.lock().await;
			if conns.contains_key(&peer.node_id) {
				return;
			}
		}

		crate::log(&format!(
			"[network] Connecting to {} at {}",
			peer.name, peer.addr
		));

		match timeout(CONNECT_TIMEOUT, TcpStream::connect(&peer.addr)).await {
			Ok(Ok(mut stream)) => {
				// Send Hello
				if let Err(e) = write_message(
					&mut stream,
					&Message::Hello {
						node_id: handle.node_id.clone(),
						name: handle.name.clone(),
						version: 1,
					},
				)
				.await
				{
					eprintln!("[network/transport] Failed to send Hello: {e}");
					tokio::time::sleep(delay).await;
					delay = (delay * 2).min(MAX_RECONNECT_DELAY);
					continue;
				}

				// Expect Hello back
				let hello = match timeout(CONNECT_TIMEOUT, read_message(&mut stream)).await {
					Ok(Ok(msg)) => msg,
					Ok(Err(e)) => {
						eprintln!("[network/transport] Handshake read error: {e}");
						tokio::time::sleep(delay).await;
						delay = (delay * 2).min(MAX_RECONNECT_DELAY);
						continue;
					}
					Err(_) => {
						eprintln!("[network/transport] Handshake timeout");
						tokio::time::sleep(delay).await;
						delay = (delay * 2).min(MAX_RECONNECT_DELAY);
						continue;
					}
				};

				let (peer_node_id, peer_name_resolved) = match &hello {
					Message::Hello { node_id, name, .. } => {
						(node_id.clone(), name.clone())
					}
					_ => {
						eprintln!("[network/transport] Expected Hello response");
						tokio::time::sleep(delay).await;
						delay = (delay * 2).min(MAX_RECONNECT_DELAY);
						continue;
					}
				};

				// Duplicate resolution: lower node_id keeps outbound
				{
					let conns = handle.connections.lock().await;
					if conns.contains_key(&peer_node_id) {
						if handle.node_id < peer_node_id {
							// We keep our outbound (this one). Drop existing.
							drop(conns);
							handle.connections.lock().await.remove(&peer_node_id);
						} else {
							// We have higher ID, they keep outbound. Drop this.
							eprintln!(
								"[network/transport] Dropping outbound to {} (they keep theirs)",
								peer_node_id
							);
							return;
						}
					}
				}

				// Register peer
				handle.store.upsert_peer(PeerInfo {
					node_id: peer_node_id.clone(),
					name: peer_name_resolved.clone(),
					addr: peer.addr.clone(),
					connected_at: Utc::now().to_rfc3339(),
					last_seen: Utc::now().to_rfc3339(),
				});

				run_connection(stream, peer_node_id, peer_name_resolved, handle).await;
				return;
			}
			Ok(Err(e)) => {
				eprintln!("[network/transport] Connect failed: {e}");
			}
			Err(_) => {
				eprintln!("[network/transport] Connect timeout to {}", peer.addr);
			}
		}

		// Check shutdown
		if Arc::strong_count(&handle.shutdown) <= 1 {
			return;
		}

		tokio::time::sleep(delay).await;
		delay = (delay * 2).min(MAX_RECONNECT_DELAY);
	}
}

/// Run a connected peer session (shared by inbound and outbound).
async fn run_connection(
	stream: TcpStream,
	peer_node_id: String,
	peer_name: String,
	handle: Arc<TransportHandle>,
) {
	let (read_half, write_half) = stream.into_split();
	let (writer_tx, mut writer_rx) = mpsc::unbounded_channel::<Message>();

	// Register connection
	{
		let mut conns = handle.connections.lock().await;
		conns.insert(
			peer_node_id.clone(),
			Connection {
				writer_tx: writer_tx.clone(),
				peer_name: peer_name.clone(),
			},
		);
	}

	crate::log(&format!(
		"[network] Connected to {} ({})",
		peer_name, peer_node_id
	));

	// Writer task
	let writer_peer_id = peer_node_id.clone();
	let writer_shutdown = handle.shutdown.clone();
	let writer_task = tokio::spawn(async move {
		let mut write_half = write_half;
		loop {
			tokio::select! {
				msg = writer_rx.recv() => {
					match msg {
						Some(message) => {
							let data = match encode_message(&message) {
								Ok(d) => d,
								Err(e) => {
									eprintln!("[network/transport] Encode error: {e}");
									continue;
								}
							};
							if let Err(e) = write_half.write_all(&data).await {
								eprintln!("[network/transport] Write to {} failed: {e}", writer_peer_id);
								return;
							}
							if let Err(e) = write_half.flush().await {
								eprintln!("[network/transport] Flush to {} failed: {e}", writer_peer_id);
								return;
							}
						}
						None => return, // Channel closed
					}
				}
				_ = writer_shutdown.notified() => return,
			}
		}
	});

	// Reader task (runs on current task)
	let mut read_half = read_half;
	let mut len_buf = [0u8; 4];
	loop {
		tokio::select! {
			result = read_half.read_exact(&mut len_buf) => {
				match result {
					Ok(_) => {
						let len = u32::from_le_bytes(len_buf);
						if len > MAX_MSG_SIZE {
							eprintln!("[network/transport] Message too large from {peer_node_id}: {len}");
							break;
						}
						let mut buf = vec![0u8; len as usize];
						match read_half.read_exact(&mut buf).await {
							Ok(_) => {
								match serde_json::from_slice::<Message>(&buf) {
									Ok(msg) => {
										handle_message(msg, &peer_node_id, &handle).await;
									}
									Err(e) => {
										eprintln!("[network/transport] Deserialize error from {peer_node_id}: {e}");
									}
								}
							}
							Err(e) => {
								eprintln!("[network/transport] Read body from {peer_node_id} failed: {e}");
								break;
							}
						}
					}
					Err(e) => {
						eprintln!("[network/transport] Read from {peer_node_id} disconnected: {e}");
						break;
					}
				}
			}
			_ = handle.shutdown.notified() => break,
		}
	}

	// Cleanup
	writer_task.abort();
	{
		let mut conns = handle.connections.lock().await;
		conns.remove(&peer_node_id);
	}
	handle.store.remove_peer(&peer_node_id);
	crate::log(&format!(
		"[network] Disconnected from {} ({})",
		peer_name, peer_node_id
	));
}

/// Handle an incoming message from a peer.
async fn handle_message(msg: Message, peer_node_id: &str, handle: &Arc<TransportHandle>) {
	match msg {
		Message::Heartbeat => {
			handle.store.touch_peer(peer_node_id);
		}
		Message::Note { envelope } => {
			// Dedup
			let is_new = {
				let mut seen = handle.seen_ids.lock().await;
				seen.insert(envelope.id.clone())
			};
			if is_new {
				crate::log(&format!(
					"[network] Received note from {}: \"{}\"",
					envelope.sender, envelope.title.as_deref().unwrap_or("(untitled)")
				));
				if handle.store.add_note(envelope) {
					handle.store.sync_to_disk();
				}
			}
		}
		Message::Retract { note_id } => {
			if handle.store.remove_note(&note_id) {
				handle.store.sync_to_disk();
				crate::log(&format!("[network] Retracted note {note_id}"));
			}
		}
		Message::Sync { notes } => {
			let mut added = 0;
			for envelope in notes {
				let is_new = {
					let mut seen = handle.seen_ids.lock().await;
					seen.insert(envelope.id.clone())
				};
				if is_new && handle.store.add_note(envelope) {
					added += 1;
				}
			}
			if added > 0 {
				handle.store.sync_to_disk();
				crate::log(&format!("[network] Synced {added} notes from {peer_node_id}"));
			}
		}
		Message::Hello { .. } => {
			// Unexpected after handshake, ignore
		}
	}
}

/// Broadcast shared notes to all connected peers.
async fn broadcast_loop(
	mut rx: mpsc::UnboundedReceiver<NoteEnvelope>,
	handle: Arc<TransportHandle>,
) {
	loop {
		tokio::select! {
			Some(envelope) = rx.recv() => {
				let msg = Message::Note { envelope };
				let conns = handle.connections.lock().await;
				for (_, conn) in conns.iter() {
					let _ = conn.writer_tx.send(msg.clone());
				}
			}
			_ = handle.shutdown.notified() => return,
		}
	}
}

// We need Message to be Clone for broadcasting
impl Clone for Message {
	fn clone(&self) -> Self {
		match self {
			Message::Hello {
				node_id,
				name,
				version,
			} => Message::Hello {
				node_id: node_id.clone(),
				name: name.clone(),
				version: *version,
			},
			Message::Note { envelope } => Message::Note {
				envelope: envelope.clone(),
			},
			Message::Retract { note_id } => Message::Retract {
				note_id: note_id.clone(),
			},
			Message::Heartbeat => Message::Heartbeat,
			Message::Sync { notes } => Message::Sync {
				notes: notes.clone(),
			},
		}
	}
}

/// Retract broadcast loop.
async fn retract_loop(
	mut rx: mpsc::UnboundedReceiver<String>,
	handle: Arc<TransportHandle>,
) {
	loop {
		tokio::select! {
			Some(note_id) = rx.recv() => {
				handle.store.remove_note(&note_id);
				handle.store.sync_to_disk();
				let msg = Message::Retract { note_id };
				let conns = handle.connections.lock().await;
				for (_, conn) in conns.iter() {
					let _ = conn.writer_tx.send(msg.clone());
				}
			}
			_ = handle.shutdown.notified() => return,
		}
	}
}

/// Heartbeat loop — sends heartbeat to all peers every 15 seconds.
async fn heartbeat_loop(handle: Arc<TransportHandle>, shutdown: Arc<Notify>) {
	let mut interval = tokio::time::interval(HEARTBEAT_INTERVAL);
	loop {
		tokio::select! {
			_ = interval.tick() => {
				let conns = handle.connections.lock().await;
				for (_, conn) in conns.iter() {
					let _ = conn.writer_tx.send(Message::Heartbeat);
				}
			}
			_ = shutdown.notified() => return,
		}
	}
}
