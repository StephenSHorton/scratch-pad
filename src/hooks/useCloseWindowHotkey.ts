import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

export function useCloseWindowHotkey(): void {
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key.toLowerCase() === "w" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				getCurrentWindow()
					.close()
					.catch(() => {});
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, []);
}
