# Picking up the project in the Claude app + adding MCP / plugins

Two different Claude surfaces are in play. They have separate config, separate
sandboxes, and separate ways to add MCP servers and plugins. Pick the right one
for the job.

---

## 1. Which surface for this project

| | Claude Code CLI (`claude`) | Claude Desktop 3P app (Cowork / Code) |
| --- | --- | --- |
| Where it runs | Your host shell, any directory | Linux VM sandbox on your laptop |
| Config | `~/.claude` (`CLAUDE.md`, memory, `settings.json`, `plugins/`) | `%LOCALAPPDATA%\Claude-3p\configLibrary`, edited **in-app** |
| Workspace limits | None; runs where you `cd` | `allowedWorkspaceFolders`; folders must be connected to a session |
| Auto-memory | Loads when project root matches (see below) | Not the same memory system |
| Dev loop (bun/vite/AWS SigV4) | Native, fast | Awkward: VM mounts + egress rules + separate creds |

**Recommendation: use the `claude` CLI for the SeegerWeissAI project.** The `claude`
CLI is already installed and on PATH. It uses the same `~/.claude` memory and
plugins, is not constrained by the desktop `allowedWorkspaceFolders` sandbox, and
runs the `bun run dev` / AWS SigV4 loop natively. The Desktop 3P Cowork VM is
built for sandboxed document work, not for driving a live Vite dev server against
Bedrock, so it is the wrong tool for this codebase.

Launch it at the memory-keyed root so the auto-memory loads:

```bash
cd "C:/Users/fshaher/.claude/projects/unifiedproductionbackend"
claude
```

Then work in the `lit-ai-extracted/lit-ai-main` subfolder. First thing to tell the
fresh instance: "read docs/HANDOFF.md in lit-ai-extracted/lit-ai-main".

If you specifically want the **desktop app UI** for this project anyway, see
section 4 — it is a governance choice only you can make, and I did not change it
for you.

## 2. Directory access the new instance needs

- **`C:\Users\fshaher\.claude\projects\unifiedproductionbackend`** — the project
  root. Contains the code under `lit-ai-extracted\lit-ai-main`, and is the path the
  auto-memory is keyed to (so `MEMORY.md` + `memory/` load automatically).
- **`C:\Users\fshaher\.claude\CLAUDE.md`** — global user instructions (loads for
  every project automatically).
- **`C:\Users\fshaher\.claude\projects\C--Users-fshaher--claude-projects-unifiedproductionbackend\memory\`**
  — the auto-memory folder (read + write, to update memory).
- **The project `.env`** (`lit-ai-extracted\lit-ai-main\.env`) — the process needs
  it; keep it permission-blocked for the agent (secrets).
- **AWS SSO profile** `AdministratorAccess-475976462949` — `aws sso login` when the
  session expires.
- Optional reference: `C:\Users\fshaher\Downloads\docketbird.com_mcp_docs.*.md`.

## 3. Claude Code CLI — MCP + plugins (already enabled)

**Plugins from GitHub are already turned on.** You have 5 marketplaces registered
and 10 plugins installed (`~/.claude/plugins/known_marketplaces.json`,
`installed_plugins.json`). To add more:

```bash
# Add a marketplace from a GitHub repo (owner/repo)
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin marketplace add <owner>/<repo>

# Then install a plugin from it
claude plugin install <plugin-name>@<marketplace-name>
claude plugin marketplace list
```

**MCP servers for Claude Code** — two ways:

1. **Per-project (recommended, version-tracked):** `.mcp.json` at the project root.
   A skeleton has been created for you at
   `lit-ai-extracted/lit-ai-main/.mcp.json`. Add servers under `mcpServers`:

   ```jsonc
   {
     "mcpServers": {
       "filesystem": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-filesystem",
                  "C:\\Users\\fshaher\\.claude\\projects\\unifiedproductionbackend"]
       }
     }
   }
   ```

2. **Ad hoc / user scope:**

   ```bash
   claude mcp add <name> -- npx -y <package>       # stdio server via npx
   claude mcp add <name> --transport http <url>    # remote HTTP/SSE server
   claude mcp list
   ```

Node 24, npx 11, bun 1.4, and `uvx` are all present, so both `npx`- and
`uvx`-launched MCP servers work.

## 4. Claude Desktop 3P app — MCP + plugins

The desktop app is the **3P (`Claude-3p`) build** signing into your firm Bedrock
account via in-app AWS SSO. Its config is at
`%LOCALAPPDATA%\Claude-3p\configLibrary`, and per your own operating rules it must
be edited **in-app**, not by writing files from outside:

> Never write policy/config to this device from outside. Config is read once at
> launch. A managed profile makes the in-app configuration window read-only.
> Author in-app, apply locally, then fully quit and reopen to test.

`%LOCALAPPDATA%\Claude-3p\config.json` also holds **live secret SSO tokens**
(`custom3pBedrockSsoTokens`, `oauth:tokenCache*`). Do not open, copy, or edit it.

**This is why I did not "just enable it" for you** — doing it correctly means
toggling settings inside the app, and doing it by editing configLibrary/registry
would violate your own precedence rules and risk the read-only-window trap.

### 4a. Enable adding GitHub / custom MCP + plugin marketplaces (in-app)

In the in-app configuration window, set:

- `userPluginMarketplacesEnabled: true` — allows adding your own marketplaces
  (GitHub `owner/repo`, or custom) beyond the official catalog.
- `userPluginUploadsEnabled: true` — allows sideloading a local/custom plugin.

(The official `anthropics/claude-plugins-official` catalog works even with both
false; these two govern *user-added* sources.) Apply, then fully quit and reopen.
Plugin state then lives in `cowork_plugins/installed_plugins.json` and
`cowork_settings.json` (`enabledPlugins`), per account+group, on the host.

### 4b. MCP inside Cowork

Cowork runs a Linux VM and exposes tools through a `workspace` MCP server inside
that VM. Two knobs matter:

- **`allowedWorkspaceFolders`** is the *permitted* set, not an auto-mount. A folder
  is only visible after you **connect it to the session** (it mounts at
  `/sessions/<session>/mnt/<folder>`). To use the desktop app on this project you
  would add the project root to `allowedWorkspaceFolders` and connect it.
- **`coworkEgressAllowedHosts`** — unset means **no network** in the VM. Set it to
  get git/pip/npm (and it would need the Bedrock/AWS hosts for this project's
  tools). This is non-trivial for the SeegerWeissAI dev loop, which is the other
  reason the CLI is the better home for this codebase.

## 5. Security guidance (law-firm posture)

- Third-party MCP servers and plugins execute code on your machine (CLI) or in the
  VM (Cowork). Treat every GitHub source as supply chain: prefer first-party
  (`anthropics/*`, `modelcontextprotocol/*`), pin versions, read the server before
  adding, and avoid granting an MCP server broad filesystem or network scope it
  does not need.
- Keep the pilot data discipline: synthetic / public data only in anything the
  desktop app can reach; no PHI, PII, or privileged material.
- Never wire a secret (API key, token) into an MCP config in plaintext where it
  could be committed. Use env-var references and keep them out of version control.
