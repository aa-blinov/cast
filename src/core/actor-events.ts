import type { AgentActorNotification } from "./actors.ts";

export type AgentActorNotificationListener = (notification: AgentActorNotification) => void;

const listeners = new Set<AgentActorNotificationListener>();

export function subscribeAgentActorNotifications(listener: AgentActorNotificationListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function publishAgentActorNotification(notification: AgentActorNotification): void {
	for (const listener of listeners) {
		try {
			listener(notification);
		} catch {
			// A disconnected UI cannot change the actor outcome or block other subscribers.
		}
	}
}
