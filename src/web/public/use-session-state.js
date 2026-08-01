import { useRef, useState } from "preact/hooks";

// Holds session data only. Network operations, SSE, and lifecycle decisions
// remain in App so this hook cannot accidentally perform I/O during render.
export function useSessionState() {
	const [sessions, setSessions] = useState([]);
	const [sessionsLoaded, setSessionsLoaded] = useState(false);
	const [defaultModel, setDefaultModel] = useState("");
	const [activeId, setActiveId] = useState(null);
	const [session, setSession] = useState(null);
	const activeSessionIdRef = useRef(null);
	activeSessionIdRef.current = activeId;
	const [personas, setPersonas] = useState([]);
	const [commands, setCommands] = useState([]);
	const [running, setRunning] = useState(false);
	const [pendingSteers, setPendingSteers] = useState([]);
	const [pendingQueue, setPendingQueue] = useState([]);
	const [planTransition, setPlanTransition] = useState(null);
	const pendingPlanSignalRef = useRef(null);
	const planRefineArmedRef = useRef(false);

	return {
		sessions,
		setSessions,
		sessionsLoaded,
		setSessionsLoaded,
		defaultModel,
		setDefaultModel,
		activeId,
		setActiveId,
		session,
		setSession,
		activeSessionIdRef,
		personas,
		setPersonas,
		commands,
		setCommands,
		running,
		setRunning,
		pendingSteers,
		setPendingSteers,
		pendingQueue,
		setPendingQueue,
		planTransition,
		setPlanTransition,
		pendingPlanSignalRef,
		planRefineArmedRef,
	};
}
