export const classifierPanel = `<div class="card" id="classifiers">
  <h2>Decision classifiers</h2>
  <p>Pi finishes your coding turn first. When a turn shows a problem, the classifier scores whether to keep it as a regression example.
  A score at or above the threshold qualifies. Suggest lets you review it, Auto saves it, and Off skips automatic classification.
  After an outage, saving a working classifier retries the latest affected turn in this session.</p>
  <p role="status" hidden id="classifier-recovery">A turn is waiting for a working classifier. Select a model and save to score that turn.</p>
  <button id="load-classifiers" onclick="loadClassifiers()">Open classifier settings</button>
  <div id="classifier-fields" hidden>
    <div class="bar"><label>Provider <select id="classifier-provider"></select></label>
      <label>Model <select id="classifier-model"></select></label></div>
    <div class="bar"><label>Save threshold <input type="number" id="classifier-threshold" min="0" max="1" step="any" required /></label>
      <label>Harvest mode <select id="classifier-mode"><option>suggest</option><option>auto</option><option>off</option></select></label></div>
    <label class="chk"><input type="checkbox" id="classifier-shadow" /> Compare routing in the background for this session</label>
    <p>Routing comparisons send a redacted request and candidate names and descriptions to the selected classifier.
    The local comparison log records the actual and suggested choices and tool completion status.</p>
    <div class="bar"><button class="primary" onclick="classifierAction('save')">Save settings</button>
      <button id="classifier-test" onclick="classifierAction('test')">Test with a synthetic turn</button></div>
  </div><div class="msg" role="status" id="classifier-message"></div></div>`;

export const classifierScript = `
let classifierConfig;
const cf = (name) => document.getElementById('classifier-' + name);
function populateModels(preferred) {
  const provider = cf('provider').value;
  const models = [...new Set([...classifierConfig.models, classifierConfig.selected])];
  const matches = provider ? models.filter((m) => m.startsWith(provider + '/')) : [''];
  cf('model').replaceChildren(...matches.map((m) => new Option(m ? m.slice(provider.length + 1) + (!classifierConfig.models.includes(m) ? " (unavailable)" : "") : 'Configured fast chat model', m)));
  if (matches.includes(preferred)) cf('model').value = preferred;
  selectClassifier();
}
function selectClassifier() {
  const m = cf('model').value;
  cf('threshold').value = m ? classifierConfig.thresholds[m] : classifierConfig.legacyThreshold;
  cf('test').disabled = !classifierConfig.models.includes(m);
  cf('shadow').disabled = !m;
  if (!m) cf('shadow').checked = false;
  if (m && m !== classifierConfig.selected) cf('mode').value = 'suggest';
}
async function loadClassifiers() {
  cf('message').textContent = 'Loading classifiers…';
  try {
    const {ok,data} = await post('/api/classifiers', {action:'list'});
    if (!ok) throw Error(data.error || 'Catalog unavailable');
    classifierConfig = data;
    const providers = [...new Set([...data.models, data.selected].filter(Boolean).map((id) => id.split('/')[0]))].sort();
    cf('provider').replaceChildren(new Option('Existing fast tier', ''), ...providers.map((p) => new Option(p,p)));
    cf('provider').value = data.selected.split('/')[0];
    cf('provider').onchange = () => populateModels();
    cf('model').onchange = selectClassifier;
    populateModels(data.selected);
    cf('mode').value = data.currentMode;
    cf('shadow').checked = data.shadow;
    document.getElementById('classifier-fields').hidden = false;
    document.getElementById('load-classifiers').textContent = 'Refresh catalog';
    cf('message').textContent = [...data.errors, ...(data.recovery ? ['Saved classifier unavailable. ' + data.recovery] : [])].join('. ');
  } catch (e) { cf('message').textContent = e.message; }
}
async function classifierAction(action) {
  if (!cf('threshold').reportValidity()) return;
  const values = {action, model:cf('model').value, mode:cf('mode').value, threshold:cf('threshold').valueAsNumber, shadow:cf('shadow').checked};
  cf('message').textContent = action === 'test' ? 'Testing…' : 'Saving…';
  try {
    const {ok,data} = await post('/api/classifiers', values);
    if (!ok) throw Error(data.error || 'Classifier request failed');
    if (action === 'test') {
      cf('message').textContent = data.model + ' · probability ' + data.probability + ' · ' + (data.save ? 'save' : 'skip') + ' · ' + data.latencyMs + ' ms';
    } else {
      classifierConfig.selected = values.model;
      if (values.model) classifierConfig.thresholds[values.model] = values.threshold;
      else classifierConfig.legacyThreshold = values.threshold;
      cf('message').textContent = 'Settings saved.';
    }
  } catch (e) { cf('message').textContent = e.message; }
}
if (location.hash === '#classifiers') loadClassifiers();
`;
