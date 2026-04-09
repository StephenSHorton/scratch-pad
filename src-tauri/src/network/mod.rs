pub mod discovery;
pub mod protocol;
pub mod room;
pub mod store;
pub mod transport;

use std::net::Ipv4Addr;
use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::Notify;

use protocol::{NoteEnvelope, PeerInfo};
use store::RemoteNoteStore;
use transport::TransportHandle;

#[allow(dead_code)]
#[derive(Clone)]
pub struct NetworkHandle {
	store: Arc<RemoteNoteStore>,
	transport: Arc<TransportHandle>,
	shutdown: Arc<Notify>,
	pub node_id: String,
	pub display_name: String,
	tcp_port: u16,
}

impl NetworkHandle {
	pub fn peers(&self) -> Vec<PeerInfo> {
		self.store.get_peers()
	}

	pub fn remote_notes(&self) -> Vec<NoteEnvelope> {
		self.store.get_all()
	}

	pub fn share_note(&self, envelope: NoteEnvelope) {
		self.transport.share_note(envelope);
	}

	pub fn retract_note(&self, note_id: &str) {
		self.transport.retract_note(note_id);
	}

	#[allow(dead_code)]
	pub fn shutdown(&self) {
		self.shutdown.notify_waiters();
		self.transport.shutdown();
	}

	/// Get the LAN IP and TCP port this instance is listening on.
	pub fn local_addr(&self) -> Result<(Ipv4Addr, u16), String> {
		let ip = room::get_lan_ip()?;
		Ok((ip, self.tcp_port))
	}

	/// Generate a room code encoding this instance's IP:port for manual peer connection.
	pub fn host_room(&self) -> Result<String, String> {
		let (ip, port) = self.local_addr()?;
		Ok(room::encode_room_code(ip, port))
	}

	/// Decode a room code and connect to the peer at that address.
	pub async fn join_room(&self, code: &str) -> Result<(String, String), String> {
		let (ip, port) = room::decode_room_code(code)?;
		let addr = format!("{ip}:{port}");
		crate::log(&format!("[network] Joining room — connecting to {addr}"));
		self.transport.connect_to_address(&addr).await
	}

	/// Disconnect from a specific peer.
	pub async fn disconnect_peer(&self, node_id: &str) -> Result<(), String> {
		self.transport.disconnect_peer(node_id).await
	}
}

pub async fn start_network(_app: AppHandle) -> NetworkHandle {
	let node_id = uuid::Uuid::new_v4().to_string();
	let display_name = discovery::resolve_display_name();

	crate::log(&format!(
		"[network] Starting P2P network — node_id={}, name={}",
		node_id, display_name
	));

	let store = Arc::new(RemoteNoteStore::new());
	let shutdown = Arc::new(Notify::new());

	// Start TCP transport (binds to OS-assigned port)
	let (tcp_port, transport) = match transport::start_transport(
		node_id.clone(),
		display_name.clone(),
		store.clone(),
	)
	.await
	{
		Ok(result) => result,
		Err(e) => {
			eprintln!("[network] Failed to start transport: {e}");
			let (_, transport) = transport::start_transport(
				node_id.clone(),
				display_name.clone(),
				store.clone(),
			)
			.await
			.expect("transport retry failed");
			return NetworkHandle {
				store,
				transport,
				shutdown,
				node_id,
				display_name,
				tcp_port: 0,
			};
		}
	};

	// Start mDNS discovery (for service registration — peers can still find us)
	// but do NOT auto-connect on discovery. Users connect manually via room codes.
	let mdns_result = discovery::start_discovery(
		node_id.clone(),
		display_name.clone(),
		tcp_port,
	);

	match mdns_result {
		Ok((_peer_rx, _daemon)) => {
			// mDNS stays running for service registration (so others can discover us)
			// but we no longer auto-connect to discovered peers.
			// The peer_rx channel is intentionally dropped — no auto-connect loop.
			std::mem::forget(_daemon);
		}
		Err(e) => {
			crate::log(&format!("[network] mDNS discovery failed (networking will be limited): {e}"));
		}
	}

	// Start TTL sweep task
	let sweep_store = store.clone();
	let sweep_shutdown = shutdown.clone();
	tokio::spawn(async move {
		let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
		loop {
			tokio::select! {
				_ = interval.tick() => {
					let swept = sweep_store.sweep_expired();
					if swept > 0 {
						sweep_store.sync_to_disk();
					}
				}
				_ = sweep_shutdown.notified() => return,
			}
		}
	});

	crate::log(&format!("[network] P2P network started on TCP port {tcp_port}"));

	NetworkHandle {
		store,
		transport,
		shutdown,
		node_id,
		display_name,
		tcp_port,
	}
}
