import { Rpc } from "@opencode/plugin/rpc";

const object = { type: "object" } as const;

/**
 * The TUI has no access to the server's options, proxy or hooks, so it reads
 * and changes everything through these methods and refreshes on `changed`.
 * `ask` opens the network popup, `failed` and `halted` show a notification.
 */
export const SandboxMode = Rpc.define({
  id: "sandbox-mode",
  methods: {
    state: { input: object, output: object },
    toggle: { input: object, output: object },
    setSetting: { input: object, output: object },
    listAdd: { input: object, output: object },
    listEdit: { input: object, output: object },
    listRemove: { input: object, output: object },
    listPromote: { input: object, output: object },
    answer: { input: object, output: object },
    release: { input: object, output: object },
    removeFiles: { input: object, output: object },
  },
  events: {
    changed: { schema: object },
    ask: { schema: object },
    failed: { schema: object },
    halted: { schema: object },
  },
});
