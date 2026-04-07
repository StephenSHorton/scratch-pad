use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteEnvelope {
	pub id: String,
	pub sender: String,
	pub sender_id: String,
	pub scope: NoteScope,
	pub intent: NoteIntent,
	pub title: Option<String>,
	pub body: String,
	pub color: String,
	pub timestamp: i64,
	pub ttl: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NoteScope {
	Local,
	Team,
	Group(String),
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "lowercase")]
pub enum NoteIntent {
	Decision,
	Question,
	Context,
	Handoff,
	Fyi,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Message {
	Hello {
		node_id: String,
		name: String,
		version: u8,
	},
	Note {
		envelope: NoteEnvelope,
	},
	Retract {
		note_id: String,
	},
	Heartbeat,
	Sync {
		notes: Vec<NoteEnvelope>,
	},
}

/// Peer info for the peers.json file and Tauri state
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
	pub node_id: String,
	pub name: String,
	pub addr: String,
	pub connected_at: String,
	pub last_seen: String,
}
