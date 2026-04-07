pub mod discovery;
pub mod protocol;
pub mod store;
pub mod transport;

use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::Notify;

use protocol::{NoteEnvelope, PeerInfo};
use store::RemoteNoteStore;
use transport::TransportHandle;

#[allow(dead_code)]
pub struct NetworkHandle {
	store: Arc<RemoteNoteStore>,
	transport: Arc<TransportHandle>,
	shutdown: Arc<Notify>,
	pub node_id: String,
	pub display_name: String,
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
}

pub async fn start_network(_app: AppHandle) -> NetworkHandle {
	let node_id = uuid::Uuid::new_v4().to_string();
	let display_name = discovery::resolve_display_name();

	eprintln!(
		"[network] Starting P2P network — node_id={}, name={}",
		node_id, display_name
	);

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
			// Return a handle that just doesn't do networking
			let (_, transport) = transport::start_transport(
				node_id.clone(),
				display_name.clone(),
				store.clone(),
			)
			.await
			.expect("transport retry failed");
			// If even retry fails, we still need a handle. Let's just use port 0.
			return NetworkHandle {
				store,
				transport,
				shutdown,
				node_id,
				display_name,
			};
		}
	};

	// Start mDNS discovery
	let mdns_result = discovery::start_discovery(
		node_id.clone(),
		display_name.clone(),
		tcp_port,
	);

	match mdns_result {
		Ok((mut peer_rx, _daemon)) => {
			// Spawn a task to handle discovered peers
			let connect_transport = transport.clone();
			tokio::spawn(async move {
				while let Some(peer) = peer_rx.recv().await {
					let t = connect_transport.clone();
					tokio::spawn(async move {
						transport::connect_to_peer(peer, t).await;
					});
				}
			});

			// We intentionally forget the daemon — it needs to live as long as the app.
			// The mDNS daemon will be cleaned up when the process exits.
			std::mem::forget(_daemon);
		}
		Err(e) => {
			eprintln!("[network] mDNS discovery failed (networking will be limited): {e}");
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

	eprintln!("[network] P2P network started on TCP port {tcp_port}");

	NetworkHandle {
		store,
		transport,
		shutdown,
		node_id,
		display_name,
	}
}
