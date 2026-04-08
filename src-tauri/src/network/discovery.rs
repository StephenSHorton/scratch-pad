use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use tokio::sync::mpsc;

const SERVICE_TYPE: &str = "_scratchpad._tcp.local.";

/// Events emitted by the discovery layer to the transport layer.
#[derive(Debug, Clone)]
pub struct DiscoveredPeer {
	pub node_id: String,
	pub name: String,
	pub addr: String, // "ip:port"
}

/// Resolve the display name: git config user.name > $USER > "anonymous"
pub fn resolve_display_name() -> String {
	// Try git config user.name
	if let Ok(output) = std::process::Command::new("git")
		.args(["config", "user.name"])
		.output()
	{
		if output.status.success() {
			let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
			if !name.is_empty() {
				return name;
			}
		}
	}

	// Fallback to $USER
	if let Ok(user) = std::env::var("USER") {
		if !user.is_empty() {
			return user;
		}
	}

	"anonymous".to_string()
}

/// Start mDNS registration and browsing.
///
/// Returns a receiver that yields discovered peers (excluding ourselves).
/// The `shutdown_rx` is used to stop the daemon when the app exits.
pub fn start_discovery(
	node_id: String,
	name: String,
	tcp_port: u16,
) -> Result<(mpsc::UnboundedReceiver<DiscoveredPeer>, ServiceDaemon), String> {
	let daemon = ServiceDaemon::new()
		.map_err(|e| format!("Failed to create mDNS daemon: {e}"))?;

	// Register our service
	let instance_name = format!("scratch-pad-{}", &node_id[..8]);
	let host = format!("{}.local.", hostname::get()
		.map(|h| h.to_string_lossy().to_string())
		.unwrap_or_else(|_| "localhost".to_string()));

	let properties = [
		("node_id", node_id.as_str()),
		("name", name.as_str()),
		("port", &tcp_port.to_string()),
		("version", "1"),
	];

	match ServiceInfo::new(
		SERVICE_TYPE,
		&instance_name,
		&host,
		"",  // Let mdns-sd resolve our IP
		tcp_port,
		&properties[..],
	) {
		Ok(service_info) => {
			if let Err(e) = daemon.register(service_info) {
				eprintln!("[network/discovery] Failed to register mDNS service: {e}");
			} else {
				crate::log(&format!("[network] Registered mDNS service: {instance_name} on port {tcp_port}"));
			}
		}
		Err(e) => {
			eprintln!("[network/discovery] Failed to create ServiceInfo: {e}");
		}
	}

	// Browse for peers
	let browse_receiver = daemon
		.browse(SERVICE_TYPE)
		.map_err(|e| format!("Failed to browse mDNS: {e}"))?;

	let (tx, rx) = mpsc::unbounded_channel();
	let our_node_id = node_id.clone();
	let seen_nodes: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

	// Spawn a thread to process mDNS events (mdns-sd uses std channels)
	std::thread::spawn(move || {
		loop {
			match browse_receiver.recv() {
				Ok(event) => match event {
					ServiceEvent::ServiceResolved(info) => {
						// Extract node_id from TXT record
						let peer_node_id = match info.get_property_val_str("node_id") {
							Some(id) => id.to_string(),
							None => continue,
						};

						// Skip ourselves
						if peer_node_id == our_node_id {
							continue;
						}

						let peer_name = info
							.get_property_val_str("name")
							.unwrap_or("unknown")
							.to_string();

						// Build address from resolved addresses
						let addresses = info.get_addresses();
						let ip = match addresses.iter().next() {
							Some(addr) => addr.to_string(),
							None => continue,
						};
						let port = info.get_port();
						let addr = format!("{ip}:{port}");

						// Only emit if we haven't seen this node yet
						let mut seen = seen_nodes.lock().unwrap();
						if seen.insert(peer_node_id.clone()) {
							crate::log(&format!(
								"[network] Discovered peer: {} ({}) at {}",
								peer_name, peer_node_id, addr
							));
							let _ = tx.send(DiscoveredPeer {
								node_id: peer_node_id,
								name: peer_name,
								addr,
							});
						}
					}
					ServiceEvent::ServiceRemoved(_type, fullname) => {
						eprintln!("[network/discovery] Service removed: {fullname}");
						// The transport layer handles disconnection via TCP
					}
					_ => {}
				},
				Err(_) => {
					eprintln!("[network/discovery] mDNS browse channel closed");
					break;
				}
			}
		}
	});

	Ok((rx, daemon))
}
