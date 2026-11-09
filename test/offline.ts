// All automated checks are offline; fixtures use isolated directories and mocks.
process.env.PI_OFFLINE = "1";
globalThis.fetch = async () => { throw new Error("Network is forbidden in context-scribe tests"); };
