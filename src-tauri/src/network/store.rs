use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::protocol::{NoteEnvelope, PeerInfo};

const MAX_TOTAL_NOTES: usize = 200;
const MAX_PER_PEER: usize = 50;
const MAX_BODY_BYTES: usize = 50 * 1024; // 50KB

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredRemoteNote {
	pub envelope: NoteEnvelope,
	pub received_at: DateTime<Utc>,
	pub expires_at: Option<DateTime<Utc>>,
}

pub struct RemoteNoteStore {
	notes: Mutex<HashMap<String, Vec<StoredRemoteNote>>>,
	peers: Mutex<Vec<PeerInfo>>,
}

impl RemoteNoteStore {
	pub fn new() -> Self {
		Self {
			notes: Mutex::new(HashMap::new()),
			peers: Mutex::new(Vec::new()),
		}
	}

	/// Add a remote note to the store. Returns false if capacity exceeded or body too large.
	pub fn add_note(&self, envelope: NoteEnvelope) -> bool {
		if envelope.body.len() > MAX_BODY_BYTES {
			eprintln!(
				"[network/store] Rejecting note {} — body exceeds {}KB",
				envelope.id,
				MAX_BODY_BYTES / 1024
			);
			return false;
		}

		let mut notes = match self.notes.lock() {
			Ok(n) => n,
			Err(e) => {
				eprintln!("[network/store] Lock poisoned in add_note: {e}");
				return false;
			}
		};

		// Check total capacity
		let total: usize = notes.values().map(|v| v.len()).sum();
		if total >= MAX_TOTAL_NOTES {
			eprintln!("[network/store] At capacity ({MAX_TOTAL_NOTES} notes), rejecting new note");
			return false;
		}

		// Check per-peer capacity
		let peer_notes = notes.entry(envelope.sender_id.clone()).or_default();
		if peer_notes.len() >= MAX_PER_PEER {
			eprintln!(
				"[network/store] Peer {} at capacity ({MAX_PER_PEER} notes), rejecting",
				envelope.sender_id
			);
			return false;
		}

		// Remove existing note with same ID (update case)
		peer_notes.retain(|n| n.envelope.id != envelope.id);

		let now = Utc::now();
		let expires_at = if envelope.ttl > 0 {
			Some(now + chrono::Duration::seconds(envelope.ttl as i64))
		} else {
			None
		};

		peer_notes.push(StoredRemoteNote {
			envelope,
			received_at: now,
			expires_at,
		});

		true
	}

	/// Remove a note by ID across all peers. Returns true if found and removed.
	pub fn remove_note(&self, note_id: &str) -> bool {
		let mut notes = match self.notes.lock() {
			Ok(n) => n,
			Err(e) => {
				eprintln!("[network/store] Lock poisoned in remove_note: {e}");
				return false;
			}
		};

		let mut found = false;
		for peer_notes in notes.values_mut() {
			let before = peer_notes.len();
			peer_notes.retain(|n| n.envelope.id != note_id);
			if peer_notes.len() < before {
				found = true;
			}
		}
		found
	}

	/// Remove all notes from a specific peer.
	pub fn remove_peer_notes(&self, sender_id: &str) {
		if let Ok(mut notes) = self.notes.lock() {
			notes.remove(sender_id);
		}
	}

	/// Remove expired notes. Returns the number of notes swept.
	pub fn sweep_expired(&self) -> usize {
		let now = Utc::now();
		let mut swept = 0;

		if let Ok(mut notes) = self.notes.lock() {
			for peer_notes in notes.values_mut() {
				let before = peer_notes.len();
				peer_notes.retain(|n| match n.expires_at {
					Some(exp) => exp > now,
					None => true,
				});
				swept += before - peer_notes.len();
			}
			// Remove empty peer entries
			notes.retain(|_, v| !v.is_empty());
		}

		if swept > 0 {
			eprintln!("[network/store] Swept {swept} expired notes");
		}
		swept
	}

	/// Get all remote note envelopes.
	pub fn get_all(&self) -> Vec<NoteEnvelope> {
		match self.notes.lock() {
			Ok(notes) => notes
				.values()
				.flat_map(|v| v.iter().map(|n| n.envelope.clone()))
				.collect(),
			Err(_) => Vec::new(),
		}
	}

	/// Sync the remote notes to disk as `remote-notes.json`.
	pub fn sync_to_disk(&self) {
		let dir = notes_dir();
		fs::create_dir_all(&dir).ok();

		let all = self.get_all();
		let json = match serde_json::to_string_pretty(&all) {
			Ok(j) => j,
			Err(e) => {
				eprintln!("[network/store] Failed to serialize remote notes: {e}");
				return;
			}
		};
		if let Err(e) = fs::write(dir.join("remote-notes.json"), json) {
			eprintln!("[network/store] Failed to write remote-notes.json: {e}");
		}
	}

	// -----------------------------------------------------------------------
	// Peer management
	// -----------------------------------------------------------------------

	/// Add or update a peer in the list.
	pub fn upsert_peer(&self, peer: PeerInfo) {
		if let Ok(mut peers) = self.peers.lock() {
			if let Some(existing) = peers.iter_mut().find(|p| p.node_id == peer.node_id) {
				existing.name = peer.name;
				existing.addr = peer.addr;
				existing.last_seen = peer.last_seen;
			} else {
				peers.push(peer);
			}
		}
		self.sync_peers_to_disk();
	}

	/// Remove a peer and all its notes.
	pub fn remove_peer(&self, node_id: &str) {
		if let Ok(mut peers) = self.peers.lock() {
			peers.retain(|p| p.node_id != node_id);
		}
		self.remove_peer_notes(node_id);
		self.sync_peers_to_disk();
		self.sync_to_disk();
	}

	/// Update the last_seen timestamp for a peer.
	pub fn touch_peer(&self, node_id: &str) {
		if let Ok(mut peers) = self.peers.lock() {
			if let Some(peer) = peers.iter_mut().find(|p| p.node_id == node_id) {
				peer.last_seen = Utc::now().to_rfc3339();
			}
		}
	}

	/// Get a snapshot of all peers.
	pub fn get_peers(&self) -> Vec<PeerInfo> {
		match self.peers.lock() {
			Ok(peers) => peers.clone(),
			Err(_) => Vec::new(),
		}
	}

	pub fn sync_peers_to_disk(&self) {
		let dir = notes_dir();
		fs::create_dir_all(&dir).ok();

		let peers = self.get_peers();
		let json = match serde_json::to_string_pretty(&peers) {
			Ok(j) => j,
			Err(e) => {
				eprintln!("[network/store] Failed to serialize peers: {e}");
				return;
			}
		};
		if let Err(e) = fs::write(dir.join("peers.json"), json) {
			eprintln!("[network/store] Failed to write peers.json: {e}");
		}
	}
}

fn notes_dir() -> PathBuf {
	let home = dirs::home_dir().expect("could not resolve home directory");
	home.join(".scratch-pad")
}
