Providers define the endpoint and credentials; model slots choose which saved provider and model each agent role uses.

Use `/provider` to open the provider picker. It can switch an existing provider, add one, or delete one. The add flow asks for a name, OpenAI-compatible base URL, API key, then fetches or accepts its models. Never put an API key in a project file, rule, skill, hook, or committed `.cast/` directory.

Use `/model [name]` to select the main model. New sessions inherit that model; an existing session keeps the model it started with unless changed explicitly. `/subagent-model` and `/plan-model` optionally override the main model for their respective roles; use `off` or the inherit option to return to the main model. `/subagent-model-provider` and `/plan-model-provider` select their provider independently.

The Model settings tab is the web equivalent: save providers first, then select the provider and model for main, subagent, and plan slots. Reasoning controls appear only when the chosen provider/model declares a supported native reasoning option. Do not invent a provider-specific parameter: use the picker or inspect the provider's documentation first.

After changing a provider, make a small real request before treating it as configured. A 401 means the key is invalid; 403 means the key or model lacks access; 404 usually means an incorrect base URL or model id. `/current` shows the effective provider/model for the current session.
