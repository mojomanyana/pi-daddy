export const preferenceFields = [
  ["scoutModel", "Scout research model", "Follow the current Pi model, or choose a connected model for research."],
  ["scoutThinking", "Scout thinking", "Auto uses low effort when the coding agent thinks, and off when it does not."],
  [
    "directUrls",
    "Scout URL fallback",
    "Allow Scout to read supplied public documentation URLs if the Docker worker is unavailable.",
  ],
  ["autoRecall", "Bookie recall", "Bring relevant project memory into a turn when Bookie has access."],
  [
    "autoDistill",
    "Bookie distillation",
    "Let Bookie extract project memory when capture and session permissions allow it.",
  ],
  ["autoStart", "Start dashboard with Pi", "Start the panel server when the next interactive root session opens."],
  [
    "autoSyncReviews",
    "Bookie automatic review capture",
    "Bookie saves a local reference when a review finishes and checks for missed reviews when Pi starts or resumes.",
  ],
  [
    "autoEscalate",
    "Automatic escalation",
    "Request a strong-model review when Principal detects a repeated failing check.",
  ],
  [
    "workspaceMemory",
    "Bookie workspace memory",
    "Switch Bookie now and remember this choice for startup. Changing Daddy Auto also switches Bookie for this session. Changing Bookie leaves Auto as it is.",
  ],
  [
    "autoOnStartup",
    "Start with Daddy Auto",
    "Approve eligible specialist tool requests in new trusted interactive sessions, including shell commands and file edits. Press [a] to change the current session.",
  ],
  [
    "maxDepth",
    "Delegation depth (1-8)",
    "Maximum specialist nesting depth (main session is 0). Defaults to 4 and survives Standard/Ambitious mode changes.",
  ],
  [
    "inheritContextFiles",
    "Inherit workspace AGENTS.md in specialists",
    "In trusted workspaces, specialists inherit root and scoped AGENTS.md instructions by default. Turn off to isolate specialists.",
  ],
  [
    "tournamentTimeoutSec",
    "Tournament candidate timeout (sec)",
    "Per-candidate wall-clock timeout in seconds before preserving completed patches and retrying missing candidates.",
  ],
] as const;
export interface PreferenceCatalog {
  models: string[];
  levels: string[];
  depthLevels?: number[];
  tournamentTimeouts?: number[];
  current: string;
  scoutReady: boolean;
  bookieSyncReady?: boolean;
  values: Record<string, string | boolean | number>;
}
export const preferencePanel = `<section class="card" id="ecosystem-settings">
  <h2>Ecosystem settings</h2><p id="pref-current"></p>
  <div class="grid2" id="pref-fields"></div><div role="status" id="pref-status"></div>
  <button onclick="loadPreferences()">Refresh connected models</button></section>`;
export const preferenceScript = `
const prefFields = ${JSON.stringify(preferenceFields)};
async function loadPreferences() {
  const status = document.getElementById('pref-status');
  try {
    const reply = await post('/api/preferences',{action:'list'});
    if (!reply.ok) throw Error(reply.data.error || 'Cannot load settings.');
    const c = reply.data, fields = document.getElementById('pref-fields');
    document.getElementById('pref-current').textContent = 'Current Pi model: ' + c.current +
      (c.scoutReady ? '' : ' · Update Scout to enable research model selection.');
    fields.replaceChildren();
    for (const [key,title,help] of prefFields) {
      const label = document.createElement('label'), caption = document.createElement('small');
      label.textContent = title; caption.textContent = help;
      const sel = document.createElement('select'), saved = c.values[key];
      const options = key === 'scoutModel'
        ? ['session', ...c.models]
        : key === 'scoutThinking'
          ? c.levels
          : key === 'maxDepth'
            ? (c.depthLevels || [1,2,3,4,5,6,7,8])
            : key === 'tournamentTimeoutSec'
              ? (c.tournamentTimeouts || [60,120,180,300,600])
              : [true,false];
      for (const value of options) sel.add(new Option(value === 'session' ? 'Follow Pi · ' + c.current : value === true ? 'On' : value === false ? 'Off' : String(value), String(value)));
      if (!options.includes(saved)) sel.add(new Option(String(saved) + ' (unavailable)', String(saved)));
      sel.value = String(saved); sel.disabled = key.startsWith('scout') && !c.scoutReady;
      if (key === 'autoSyncReviews' && !c.bookieSyncReady) {
        sel.disabled = true;
        caption.textContent = 'Load the Bookie review sync update to use this setting.';
      }
      sel.onchange = async () => {
        sel.disabled = true;
        try {
          const value = typeof saved === 'boolean' ? sel.value === 'true' : typeof saved === 'number' ? Number(sel.value) : sel.value;
          const r = await post('/api/preferences',{action:'save',key,value});
          if (!r.ok) throw Error(r.data.error || 'Save failed.');
          status.textContent = title + ' saved.';
        } catch(e) { status.textContent = e.message; await loadPreferences(); }
        finally { sel.disabled = false; }
      };
      label.append(sel,caption); fields.append(label);
    }
    for (const id of ['m-fast','m-work','m-strong']) document.getElementById(id).setAttribute('list','chat-models');
    const list = document.getElementById('chat-models');
    list.replaceChildren(...['session', ...c.models].map(id => new Option(id,id)));
  } catch(e) { status.textContent = e.message; }
}
void loadPreferences();
`;
