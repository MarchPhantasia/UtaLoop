import {
  config, endpointOf, llmReady, loadConfig, modelConnection, REASONING_LEVELS,
  removeModelProvider, saveModelProvider, selectModelProvider,
} from './config.js';
import { errorMessage } from './errors.js';
import { chat, listModels } from './llm.js';
import { button, buttonBar, inputField, navRow, segRow } from './rows.js';
import { openConfirm, openMenu, openSheet, sheetOpen } from './sheet.js';
import { el, icon, toast } from './util.js';

export function aiSettingsEntry({ onBack } = {}) {
  loadConfig();
  const entry = navRow('AI 助学', '模型服务商与歌词校对', {
    onPick: () => openAISettings({ onBack, onUpdate: refresh }),
  });
  const mark = el('span', 'ai-settings-mark');
  mark.append(icon('i-spark'));
  entry.classList.add('ai-settings-entry');
  entry.setAttribute('aria-haspopup', 'dialog');
  entry.prepend(mark);
  function refresh() {
    const ready = llmReady();
    entry.setValue(ready ? '已配置' : '未配置');
    entry.dataset.configured = String(ready);
  }
  refresh();
  return entry;
}

function openAISettings({ onBack, onUpdate }) {
  loadConfig();
  onUpdate();
  const drafts = new Map();

  function draftFor(id) {
    if (!drafts.has(id)) {
      const provider = config.providers.find((item) => item.id === id);
      const empty = { id: '', name: '', baseUrl: '', apiKey: '', model: '', reasoningEffort: '' };
      drafts.set(id, provider ? { ...provider } : empty);
    }
    return drafts.get(id);
  }

  function editProvider(draft = draftFor(config.activeProviderId), message = '') {
    const body = el('div', 'ai-model-pane');
    const fields = el('div', 'ai-model-fields');
    const status = el('p', 'ai-status', message);
    status.setAttribute('role', 'status');
    let request, closeMenu;

    const saved = config.providers.find((item) => item.id === draft.id);
    if (config.providers.length) {
      const bar = el('div', 'ai-provider-bar');
      const select = button(saved?.name || '新服务商', { onPick: () => {
        closeMenu = openMenu(select, config.providers.map((item) => ({
          label: item.name,
          icon: item.id === config.activeProviderId ? 'i-check' : '',
          onPick: () => {
            if (item.id === draft.id) return;
            try {
              selectModelProvider(item.id);
              onUpdate();
              editProvider();
            } catch (error) { showError(error, '切换服务商失败，请重试'); }
          },
        })));
      } });
      select.classList.add('ai-provider-switch');
      select.append(icon('i-chev-d', 'ic ic-sm'));
      select.setAttribute('aria-haspopup', 'menu');
      select.setAttribute('aria-label', '切换服务商 · ' + (saved?.name || '新服务商'));
      const add = button('新增', { glyph: 'i-plus', onPick: () => editProvider(draftFor('')) });
      add.disabled = !draft.id;
      bar.append(el('b', null, '服务商'), select, add);
      body.append(bar);
    }

    const name = inputField('服务商名称', {
      value: draft.name, placeholder: '选填，默认使用接口域名', onInput: (v) => edit('name', v),
    });
    const address = inputField('接口地址', {
      value: draft.baseUrl, type: 'url', placeholder: 'https://api.example.com/v1', onInput: (v) => edit('baseUrl', v),
    });
    const key = inputField('API Key', {
      value: draft.apiKey, placeholder: '粘贴服务商提供的 Key', secret: true, onInput: (v) => edit('apiKey', v),
    });
    const model = inputField('模型 ID', {
      value: draft.model, placeholder: '从列表选取或手动填写', onInput: (v) => edit('model', v),
    });
    const browse = button('模型列表', { onPick: browseModels });
    browse.setAttribute('aria-haspopup', 'dialog');
    const modelRow = el('div', 'ai-model-row');
    modelRow.append(model, browse);
    const effort = segRow('思考程度', '', () => draft.reasoningEffort,
      (value) => edit('reasoningEffort', value), REASONING_LEVELS, { wrap: true });
    effort.classList.add('ai-reasoning');
    fields.append(name, address, key, modelRow, effort);
    body.append(fields, status);

    const test = button('测试连接', { onPick: testDraft });
    const save = button('保存并使用', { main: true, onPick: saveDraft });
    const remove = saved ? button('移除', { onPick: removeDraft }) : null;
    if (remove) remove.classList.add('ai-remove-provider');
    const footer = buttonBar(remove, test, save);
    footer.classList.add('ai-save-controls');
    const actions = onBack ? [button('返回', { glyph: 'i-back', onPick: onBack })] : [];
    openSheet('AI 助学', body, { cls: 'sheet-tall ai-settings-sheet', actions, footer,
      onClose: () => { request?.abort(); closeMenu?.(); } });

    function edit(field, value) {
      draft[field] = value;
      request?.abort();
      request = null;
      test.disabled = browse.disabled = false;
      status.textContent = '';
      address.input.removeAttribute('aria-invalid');
      model.input.removeAttribute('aria-invalid');
    }

    function verifyAddress() {
      if (endpointOf(draft.baseUrl)) return true;
      status.textContent = '请输入有效的接口地址，例如 https://api.example.com/v1';
      address.input.setAttribute('aria-invalid', 'true');
      address.input.focus();
      return false;
    }

    function showError(error, fallback) { status.textContent = errorMessage(error, fallback); }

    function startRequest(message) {
      request = new AbortController();
      test.disabled = browse.disabled = true;
      status.textContent = message;
      return request;
    }

    function endRequest(current) {
      if (request !== current) return;
      request = null;
      test.disabled = browse.disabled = false;
    }

    async function browseModels() {
      if (request || !verifyAddress()) return;
      const current = startRequest('正在获取模型列表…');
      try {
        const items = await listModels(draft, { signal: current.signal });
        if (current.signal.aborted) return;
        if (!items.length) {
          status.textContent = '服务商未返回模型，可以手动填写模型 ID';
          return;
        }
        const back = () => editProvider(draft);
        modelPicker(items, draft.model, (id) => { draft.model = id; back(); }, back);
      } catch (error) {
        if (!current.signal.aborted) showError(error, '获取模型列表失败，可以手动填写模型 ID');
      } finally {
        endRequest(current);
      }
    }

    function verifyModel() {
      if (!verifyAddress()) return false;
      if (modelConnection(draft).model) return true;
      status.textContent = '请选择模型或填写模型 ID';
      model.input.setAttribute('aria-invalid', 'true');
      model.input.focus();
      return false;
    }

    async function testDraft() {
      if (request || !verifyModel()) return;
      const current = startRequest('正在测试模型连接…');
      try {
        await chat({ connection: draft, messages: [{ role: 'user', content: 'Reply only with OK.' }],
          maxTokens: 768, signal: current.signal, retries: 0 });
        if (!current.signal.aborted) status.textContent = '连接成功，模型已返回响应';
      } catch (error) {
        if (!current.signal.aborted) showError(error, '模型连接失败，请检查设置后重试');
      } finally {
        endRequest(current);
      }
    }

    function saveDraft() {
      if (!verifyModel()) return;
      try {
        saveModelProvider(draft);
        drafts.delete(draft.id);
        onUpdate();
        editProvider();
        toast('已保存并使用');
      } catch (error) { showError(error, '保存服务商失败，请重试'); }
    }

    async function removeDraft() {
      const confirmed = await openConfirm('移除服务商', '此服务商的本地配置将被删除。', { danger: true, ok: '移除' });
      if (sheetOpen()) return;
      if (!confirmed) { editProvider(draft); return; }
      try {
        removeModelProvider(draft.id);
        drafts.delete(draft.id);
        onUpdate();
        editProvider();
      } catch (error) { editProvider(draft, errorMessage(error, '移除服务商失败，请重试')); }
    }
  }
  editProvider();
}

function modelPicker(models, selected, onSelect, onBack) {
  const body = el('div', 'ai-picker');
  const search = inputField('搜索模型', { type: 'search', placeholder: '名称或模型 ID', onInput: paint });
  const result = el('div', 'ai-model-list');
  const status = el('p', 'ai-status');
  status.setAttribute('role', 'status');
  const actions = [button('返回', { glyph: 'i-back', onPick: onBack })];
  body.append(search, status, result);
  paint('');
  openSheet('选择模型', body, { cls: 'sheet-tall ai-settings-sheet', actions, onBack });

  function paint(query) {
    const term = query.trim().toLowerCase();
    const matches = term ? models.filter(({ id, name }) =>
      id.toLowerCase().includes(term) || name.toLowerCase().includes(term)) : models;
    const rows = matches.slice(0, 100).map(({ id, name }) => {
      const row = el('button', 'ai-model-option');
      row.type = 'button';
      const label = el('span', 'ai-model-label');
      label.append(el('b', null, name || id));
      if (name && name !== id) label.append(el('small', null, id));
      row.append(label);
      if (id === selected) {
        row.setAttribute('aria-current', 'true');
        row.append(icon('i-check', 'ic ic-sm'));
      }
      row.addEventListener('click', () => onSelect(id));
      return row;
    });
    result.replaceChildren(...rows);
    status.textContent = !matches.length ? '没有匹配的模型'
      : matches.length > rows.length ? `共 ${matches.length} 个模型，可搜索查看更多` : '';
  }
}
