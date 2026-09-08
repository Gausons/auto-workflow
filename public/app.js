import { renderMessages } from './historyView.js';

const state = {
  config: {},
  user: null,
  permissions: [],
  scheduler: {},
  bugs: [],
  runs: [],
  executionRecords: [],
  storageUserKey: "",
  assignmentPeople: [],
  metrics: {},
  selectedBugId: null,
  selectedRunId: null,
  selectedNodeId: "pull",
  view: currentView()
};

const historyState = { offset: 0, total: 0, selected: null, listRequest: 0, detailRequest: 0, detail: null, agent: '', query: '', workspace: '' };

const els = {
  configForm: document.querySelector("#configForm"),
  assigneeSelect: document.querySelector("#assigneeSelect"),
  assignmentPeopleForm: document.querySelector("#assignmentPeopleForm"),
  assignmentPeopleList: document.querySelector("#assignmentPeopleList"),
  bugList: document.querySelector("#bugList"),
  bugDetail: document.querySelector("#bugDetail"),
  pipelineBugList: document.querySelector("#pipelineBugList"),
  runList: document.querySelector("#runList"),
  executionRecordList: document.querySelector("#executionRecordList"),
  executionRecordUser: document.querySelector("#executionRecordUser"),
  executionRecordCount: document.querySelector("#executionRecordCount"),
  executionRecordRunCount: document.querySelector("#executionRecordRunCount"),
  pipelineSteps: document.querySelector("#pipelineSteps"),
  pipelineNodeCount: document.querySelector("#pipelineNodeCount"),
  nodeDetail: document.querySelector("#nodeDetail"),
  logBox: document.querySelector("#logBox"),
  taskPacket: document.querySelector("#taskPacket"),
  ideSupplementPanel: document.querySelector("#ideSupplementPanel"),
  ideSupplementText: document.querySelector("#ideSupplementText"),
  ideSupplementImages: document.querySelector("#ideSupplementImages"),
  ideSupplementFileState: document.querySelector("#ideSupplementFileState"),
  ideSupplementState: document.querySelector("#ideSupplementState"),
  ideSupplementSaved: document.querySelector("#ideSupplementSaved"),
  attachmentPreviewModal: document.querySelector("#attachmentPreviewModal"),
  attachmentPreviewTitle: document.querySelector("#attachmentPreviewTitle"),
  attachmentPreviewImage: document.querySelector("#attachmentPreviewImage"),
  attachmentPreviewState: document.querySelector("#attachmentPreviewState"),
  attachmentPreviewDownload: document.querySelector("#attachmentPreviewDownload"),
  attachmentPreviewClose: document.querySelector("#attachmentPreviewClose"),
  toast: document.querySelector("#toast"),
  assignAll: document.querySelector("#assignAll"),
  syncNow: document.querySelector("#syncNow"),
  openPipeline: document.querySelector("#openPipeline"),
  runManual: document.querySelector("#runManual"),
  runAuto: document.querySelector("#runAuto"),
  ideExecutorPicker: document.querySelector("#ideExecutorPicker"),
  startNode: document.querySelector("#startNode"),
  startReview: document.querySelector("#startReview"),
  startVerify: document.querySelector("#startVerify"),
  stopNode: document.querySelector("#stopNode"),
  completeNode: document.querySelector("#completeNode"),
  reviewNode: document.querySelector("#reviewNode"),
  toggleScheduler: document.querySelector("#toggleScheduler"),
  copyTask: document.querySelector("#copyTask"),
  copyCommand: document.querySelector("#copyCommand"),
  handoffMeta: document.querySelector("#handoffMeta"),
  syncState: document.querySelector("#syncState"),
  selectedState: document.querySelector("#selectedState"),
  runState: document.querySelector("#runState"),
  assignmentPeopleState: document.querySelector("#assignmentPeopleState"),
  credentialState: document.querySelector("#credentialState"),
  sidebarCredentialDot: document.querySelector("#sidebarCredentialDot"),
  sidebarCredentialText: document.querySelector("#sidebarCredentialText")
};

const attachmentRequests = new Set();
let pollTimer = null;
let configFormDirty = false;

init();

const roleLabels = { owner: "组织所有者", admin: "管理员", operator: "操作员", viewer: "只读成员" };
const can = (permission) => state.permissions.includes(permission);

async function init() {
  bindEvents();
  // Version 0.2 shared organization tokens are never treated as member sessions.
  sessionStorage.removeItem("bugflow.tenantToken");
  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector("button");
    button.disabled = true;
    try {
      const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      sessionStorage.setItem("bugflow.sessionToken", data.token);
      location.reload();
    } catch (error) { document.querySelector("#loginError").textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.querySelector("#setupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector("button");
    const { token, ...input } = Object.fromEntries(new FormData(form));
    button.disabled = true;
    try {
      const data = await api("/api/auth/setup", { method: "POST", headers: { Authorization: `Bearer ${token.trim()}` }, body: JSON.stringify(input) });
      document.querySelector("#loginOrganization").value = data.tenant.id;
      document.querySelector("#loginUsername").value = input.username;
      form.reset();
      document.querySelector("#setupDetails").open = false;
      document.querySelector("#loginError").textContent = data.message;
    } catch (error) { document.querySelector("#setupError").textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.querySelector("#logoutTenant").addEventListener("click", async () => {
    try { await api("/api/auth/logout", { method: "POST" }); }
    catch (error) { if (error.status !== 401) { showToast(error.message); return; } }
    sessionStorage.removeItem("bugflow.sessionToken"); location.reload();
  });
  bindMemberEvents();
  if (sessionStorage.getItem("bugflow.sessionToken")) {
    try { await loadBootstrap(); showWorkspace(); if (state.view === "members") await loadMembers(); if (state.view === "history") await loadAgentHistory(); }
    catch (error) { document.querySelector("#loginError").textContent = error.message; }
  }
}

function renderPermissions() {
  for (const [key, permission] of Object.entries({ canExecute: 'work.execute', canApprove: 'work.approve', canConfigure: 'config.manage', canManagePeople: 'people.manage', canManageMembers: 'members.manage' })) {
    document.body.dataset[key] = String(can(permission));
  }
  if (state.user) {
    const label = `${state.user.displayName} · ${roleLabels[state.user.role]}`;
    document.querySelector('#currentUser').textContent = label;
    document.querySelector('#accountIdentity').textContent = `${state.user.username} · ${label}`;
  }
  if ((state.view === 'members' && !can('members.manage')) || (state.view === 'config' && !can('config.manage'))) state.view = 'workbench';
  document.querySelectorAll('#assignmentPeopleList input, #assignmentPeopleList textarea').forEach((input) => { input.readOnly = !can('people.manage'); });
}

function availableRoles() {
  return state.user?.role === 'owner' ? Object.keys(roleLabels) : ['operator', 'viewer'];
}
function roleOptions(selected = 'viewer') {
  return availableRoles().map((role) => `<option value="${role}" ${role === selected ? 'selected' : ''}>${roleLabels[role]}</option>`).join('');
}
async function loadMembers() {
  if (!can('members.manage')) return;
  const [data, audit] = await Promise.all([api('/api/organization/members'), api('/api/organization/audit')]);
  document.querySelector('#newMemberRole').innerHTML = roleOptions();
  document.querySelector('#memberStatus').textContent = `${data.members.length} 位成员`;
  document.querySelector('#memberList').innerHTML = data.members.map((member) => {
    const editable = state.user.role === 'owner' || !['owner', 'admin'].includes(member.role);
    return `<form class="member-card" data-member-id="${escapeHtml(member.id)}">
      <strong>${escapeHtml(member.username)} · ${roleLabels[member.role]} · ${member.enabled ? '已启用' : '已停用'}</strong>
      ${editable ? `<div class="fields-grid">
        <label>显示名称<input name="displayName" value="${escapeHtml(member.displayName)}" required maxlength="80" /></label>
        <label>角色<select name="role">${roleOptions(member.role)}</select></label>
        <label>状态<select name="enabled"><option value="true" ${member.enabled ? 'selected' : ''}>启用</option><option value="false" ${member.enabled ? '' : 'selected'}>停用</option></select></label>
        <button class="button secondary" type="submit">保存成员</button>
        <label>重置密码<input name="newPassword" type="password" autocomplete="new-password" placeholder="12–128 位" maxlength="128" /></label>
        <button class="button secondary" type="button" data-reset-password>重置密码并撤销会话</button>
      </div>` : `<p>${escapeHtml(member.displayName)}，由组织所有者管理</p>`}
    </form>`;
  }).join('');
  document.querySelector('#auditList').innerHTML = audit.events.map((event) => `<div class="member-card"><strong>${escapeHtml(event.actorName)} · ${escapeHtml(event.action)}</strong><p>${escapeHtml(event.createdAt)} · ${escapeHtml(event.target)}</p></div>`).join('') || '<p>暂无审计记录</p>';
}
function bindMemberEvents() {
  document.querySelector('#refreshMembers').addEventListener('click', () => loadMembers().catch((error) => showToast(error.message)));
  document.querySelector('#memberForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/organization/members', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset(); await loadMembers(); showToast('成员已创建');
    } catch (error) { document.querySelector('#memberStatus').textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.querySelector('#memberList').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target.closest('[data-member-id]');
    if (!form) return;
    const { role, displayName, enabled } = Object.fromEntries(new FormData(form));
    try {
      await api(`/api/organization/members/${form.dataset.memberId}`, { method: 'PATCH', body: JSON.stringify({ role, displayName, enabled: enabled === 'true' }) });
      await loadBootstrap({ silent: true }); await loadMembers(); showToast('成员已更新');
    } catch (error) { showToast(error.message); }
  });
  document.querySelector('#memberList').addEventListener('click', async (event) => {
    if (!event.target.closest('[data-reset-password]')) return;
    const form = event.target.closest('[data-member-id]');
    try {
      await api(`/api/organization/members/${form.dataset.memberId}/password`, { method: 'PUT', body: JSON.stringify({ password: form.elements.newPassword.value }) });
      form.elements.newPassword.value = '';
      if (form.dataset.memberId === state.user.id) { sessionStorage.removeItem('bugflow.sessionToken'); location.reload(); return; }
      showToast('密码已重置，原会话已撤销'); await loadMembers();
    } catch (error) { showToast(error.message); }
  });
  document.querySelector('#passwordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/auth/password', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      sessionStorage.removeItem('bugflow.sessionToken'); location.reload();
    } catch (error) { document.querySelector('#passwordStatus').textContent = error.message; }
  });
}

function showWorkspace() {
  document.querySelector("#loginScreen").hidden = true;
  document.querySelector("#workspaceShell").hidden = false;
}

function bindEvents() {
  bindHistoryEvents();
  window.addEventListener("hashchange", () => {
    state.view = currentView();
    render();
    if (state.view === "members") loadMembers().catch((error) => showToast(error.message));
    if (state.view === "history") loadAgentHistory();
  });

  els.assignAll.addEventListener("click", applyAllAssignments);
  els.syncNow.addEventListener("click", syncNow);
  els.openPipeline.addEventListener("click", openPipeline);
  els.runManual.addEventListener("click", () => createRun("manual"));
  els.runAuto.addEventListener("click", () => createRun("auto"));
  els.startNode.addEventListener("click", startSelectedRun);
  els.startReview.addEventListener("click", startSelectedReview);
  els.startVerify.addEventListener("click", startSelectedVerification);
  els.stopNode.addEventListener("click", stopSelectedRun);
  els.completeNode.addEventListener("click", () => completeSelectedNode("done"));
  els.reviewNode.addEventListener("click", () => completeSelectedNode("attention"));
  els.toggleScheduler.addEventListener("click", toggleScheduler);
  els.copyTask.addEventListener("click", copyTaskPacket);
  els.copyCommand.addEventListener("click", copyIdeCommand);
  els.ideSupplementImages.addEventListener("change", updateSupplementFileState);
  els.attachmentPreviewClose.addEventListener("click", closeAttachmentPreview);
  els.attachmentPreviewModal.addEventListener("click", (event) => {
    if (event.target === els.attachmentPreviewModal) closeAttachmentPreview();
  });
  els.attachmentPreviewImage.addEventListener("load", () => {
    els.attachmentPreviewState.hidden = true;
  });
  els.attachmentPreviewImage.addEventListener("error", () => {
    els.attachmentPreviewState.hidden = false;
    els.attachmentPreviewState.textContent = "图片加载失败，可使用下载按钮获取原文件。";
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.attachmentPreviewModal.hidden) {
      closeAttachmentPreview();
    }
  });

  if (els.ideExecutorPicker) {
    els.ideExecutorPicker.addEventListener("change", () => {
      state.config.ideExecutor = els.ideExecutorPicker.value;
      syncIdeExecutorPicker();
    });
  }

  els.configForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveConfig();
  });

  els.configForm.addEventListener("input", () => {
    configFormDirty = true;
  });

  els.configForm.addEventListener("change", (event) => {
    configFormDirty = true;
    if (event.target?.name === "ideExecutor") {
      updateIdeModelFields(event.target.value);
    }
  });

  els.assigneeSelect.addEventListener("change", () => {
    const value = els.assigneeSelect.value;
    if (!value) return;
    els.configForm.elements.assignee.value = value;
    configFormDirty = true;
  });

  els.assignmentPeopleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await addAssignmentPerson();
  });

  els.assignmentPeopleList.addEventListener("click", async (event) => {
    const saveButton = event.target.closest("[data-save-person]");
    if (saveButton) {
      await saveAssignmentPerson(saveButton.dataset.savePerson);
      return;
    }

    const deleteButton = event.target.closest("[data-delete-person]");
    if (deleteButton) {
      await deleteAssignmentPerson(deleteButton.dataset.deletePerson);
    }
  });

  els.bugList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-bug-id]");
    if (!button) return;
    selectBug(button.dataset.bugId);
    render();
    loadBugAttachments(state.selectedBugId);
  });

  els.pipelineBugList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pipeline-bug-id]");
    if (!button) return;
    selectBug(button.dataset.pipelineBugId);
    render();
    loadBugAttachments(state.selectedBugId);
  });

  els.runList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-run-id]");
    if (!button) return;
    const run = state.runs.find((item) => item.id === button.dataset.runId);
    if (!run) return;
    state.selectedBugId = run.bugId;
    state.selectedRunId = run.id;
    state.selectedNodeId = selectedRun()?.steps?.[0]?.id || "pull";
    render();
  });

  els.executionRecordList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-record-run-id]");
    if (!button || !button.dataset.recordRunId) return;
    const run = state.runs.find((item) => item.id === button.dataset.recordRunId);
    if (!run) return;
    state.selectedBugId = run.bugId;
    state.selectedRunId = run.id;
    state.selectedNodeId = run.steps?.[0]?.id || "pull";
    location.hash = "pipeline";
  });

  els.pipelineSteps.addEventListener("click", (event) => {
    const button = event.target.closest("[data-node-id]");
    if (!button) return;
    state.selectedNodeId = button.dataset.nodeId;
    renderPipeline();
  });

  els.bugDetail.addEventListener("click", (event) => {
    const previewButton = event.target.closest("[data-attachment-preview]");
    if (previewButton) {
      openAttachmentPreview(Number(previewButton.dataset.attachmentPreview));
      return;
    }

    const recommendButton = event.target.closest("[data-assignment-recommend]");
    if (recommendButton) {
      refreshAssignmentRecommendation();
      return;
    }

    const applyButton = event.target.closest("[data-assignment-apply]");
    if (applyButton) {
      applyAssignmentRecommendation();
    }
  });
}

async function stopSelectedRun() {
  const run = selectedRun();
  if (!run) {
    showToast("请先选择一个流水线");
    return;
  }

  els.stopNode.disabled = true;
  try {
    const node = selectedNode();
    const target = node?.id === "verify" ? "verify" : node?.id === "review" ? "review" : "execute";
    const data = await api(`/api/workflows/${encodeURIComponent(run.id)}/stop`, {
      method: "POST",
      body: JSON.stringify({ target })
    });

    const runIndex = state.runs.findIndex((item) => item.id === data.run.id);
    if (runIndex >= 0) state.runs[runIndex] = data.run;
    if (data.bug) {
      const bugIndex = state.bugs.findIndex((item) => item.id === data.bug.id);
      if (bugIndex >= 0) state.bugs[bugIndex] = data.bug;
    }
    render();
    configurePolling();
    showToast("已发送停止请求");
  } catch (error) {
    showToast(error.message);
  } finally {
    els.stopNode.disabled = false;
  }
}

async function loadBootstrap({ silent = false } = {}) {
  const data = await api("/api/bootstrap");
  applyBootstrap(data);
  if (!silent) showToast("工作台已加载");
}

function applyBootstrap(data) {
  if (data.tenant) document.querySelector("#tenantName").textContent = `${data.tenant.name} (${data.tenant.id})`;
  Object.assign(state, {
    user: data.user || state.user,
    permissions: data.permissions || state.permissions,
    config: data.config,
    scheduler: data.scheduler,
    assignmentPeople: data.assignmentPeople || [],
    bugs: data.bugs,
    runs: data.runs,
    executionRecords: data.executionRecords || [],
    storageUserKey: data.storageUserKey || "",
    metrics: data.metrics
  });

  if (!selectedBug() && state.bugs.length) {
    state.selectedBugId = state.bugs[0].id;
  }

  state.selectedRunId = selectedRun()?.id || latestRunForBug(state.selectedBugId)?.id || null;

  render();
  loadBugAttachments(state.selectedBugId);
  configurePolling();
}

async function syncNow() {
  els.syncNow.disabled = true;
  try {
    const data = await api("/api/sync", { method: "POST" });
    applyBootstrap(data);
    showToast(data.scheduler.lastRunMessage);
  } catch (error) {
    showToast(error.message);
  } finally {
    els.syncNow.disabled = false;
  }
}

async function saveConfig() {
  const form = new FormData(els.configForm);
  const payload = Object.fromEntries(form.entries());
  payload.mode = state.config.mode;
  payload.intervalMinutes = Number(payload.intervalMinutes);
  payload.pageSize = Number(payload.pageSize);
  payload.maxPages = Number(payload.maxPages);
  payload.requestDelayMs = Number(payload.requestDelayMs);
  payload.rateLimitRetryMs = Number(payload.rateLimitRetryMs);
  payload.aiRoutingTimeoutMs = Number(payload.aiRoutingTimeoutMs);
  if (form.has("codexReviewMaxRounds")) {
    payload.codexReviewMaxRounds = Number(payload.codexReviewMaxRounds);
  }
  payload.selfOnly = form.get("selfOnly") === "true";
  payload.enableBugInfoCompletion = form.get("enableBugInfoCompletion") === "true";
  payload.allowSkipInfoCompletion = form.get("allowSkipInfoCompletion") === "true";
  payload.enableAIRouting = form.get("enableAIRouting") === "true";
  payload.enableAIAssignment = form.get("enableAIAssignment") === "true";
  payload.enableAutoAssignment = form.get("enableAutoAssignment") === "true";
  payload.allowedAutoFixPriorities = String(payload.allowedAutoFixPriorities || "P2,P3")
    .split(/[,\s]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  payload.requireVerificationReport = form.get("requireVerificationReport") === "true";
  payload.requireRegressionTest = form.get("requireRegressionTest") === "true";
  payload.requireHumanReview = form.get("requireHumanReview") === "true";

  const data = await api("/api/config", {
    method: "PUT",
    body: JSON.stringify(payload)
  });

  configFormDirty = false;
  applyBootstrap(data);
  showToast("配置已保存");
}

async function addAssignmentPerson() {
  const form = new FormData(els.assignmentPeopleForm);
  const person = {
    name: String(form.get("name") || "").trim(),
    employeeId: String(form.get("employeeId") || "").trim(),
    responsibility: String(form.get("responsibility") || "").trim()
  };

  if (!person.name || !person.employeeId || !person.responsibility) {
    showToast("姓名、员工号和职责都需要填写");
    return;
  }

  const people = [
    ...state.assignmentPeople.filter((item) => item.employeeId !== person.employeeId),
    person
  ];
  await saveAssignmentPeople(people, "人员已添加");
  els.assignmentPeopleForm.reset();
}

async function saveAssignmentPerson(employeeId) {
  const card = els.assignmentPeopleList.querySelector(`[data-person-id="${cssEscape(employeeId)}"]`);
  if (!card) return;

  const person = readAssignmentPersonFromCard(card);
  if (!person.name || !person.employeeId || !person.responsibility) {
    showToast("姓名、员工号和职责都需要填写");
    return;
  }

  const people = state.assignmentPeople
    .filter((item) => item.employeeId !== employeeId && item.employeeId !== person.employeeId)
    .concat(person);
  await saveAssignmentPeople(people, "人员职责已保存");
}

async function deleteAssignmentPerson(employeeId) {
  if (state.assignmentPeople.length <= 1) {
    showToast("至少保留一个可分配人员");
    return;
  }

  const person = state.assignmentPeople.find((item) => item.employeeId === employeeId);
  const ok = window.confirm(`确认删除 ${person?.name || employeeId} 的分配规则？`);
  if (!ok) return;

  await saveAssignmentPeople(state.assignmentPeople.filter((item) => item.employeeId !== employeeId), "人员已删除");
}

function readAssignmentPersonFromCard(card) {
  return {
    name: card.querySelector('[name="personName"]')?.value.trim() || "",
    employeeId: card.querySelector('[name="personEmployeeId"]')?.value.trim() || "",
    responsibility: card.querySelector('[name="personResponsibility"]')?.value.trim() || ""
  };
}

async function saveAssignmentPeople(people, successMessage) {
  const data = await api("/api/assignment/people", {
    method: "PUT",
    body: JSON.stringify({ people })
  });

  applyBootstrap(data);
  showToast(successMessage || "分配规则已保存");
}

async function toggleScheduler() {
  const data = await api("/api/scheduler", {
    method: "POST",
    body: JSON.stringify({ enabled: !state.scheduler.enabled })
  });

  applyBootstrap(data);
  showToast(state.scheduler.enabled ? "定时拉取已开启" : "定时拉取已关闭");
}

function openPipeline() {
  if (!selectedBug()) {
    showToast("请先选择一个缺陷");
    return;
  }
  state.selectedRunId = latestRunForBug(state.selectedBugId)?.id || null;
  state.selectedNodeId = selectedRun()?.steps?.[0]?.id || "pull";
  location.hash = "pipeline";
}

async function createRun(executionMode) {
  const bug = selectedBug();
  if (!bug) {
    showToast("请先选择一个缺陷");
    return;
  }

  const ideExecutor = els.ideExecutorPicker?.value || state.config.ideExecutor || "codex";

  els.runManual.disabled = true;
  els.runAuto.disabled = true;
  try {
    const data = await api("/api/workflows/run", {
      method: "POST",
      body: JSON.stringify({ bugId: bug.id, executionMode, startExecution: false, ideExecutor })
    });

    const index = state.bugs.findIndex((item) => item.id === data.bug.id);
    if (index >= 0) state.bugs[index] = data.bug;
    state.metrics = calculateMetrics(state.bugs);
    state.selectedBugId = data.bug.id;
    state.runs = [data.run, ...state.runs.filter((run) => run.id !== data.run.id)].slice(0, 20);
    state.selectedRunId = data.run.id;
    state.selectedNodeId = data.run.steps[0]?.id || "pull";
    location.hash = "pipeline";
    render();
    configurePolling();
    showToast(executionMode === "auto" ? "已生成自动流水线，可预览后执行" : "已生成人工流水线，可预览后执行");
  } catch (error) {
    showToast(error.message);
  } finally {
    els.runManual.disabled = false;
    els.runAuto.disabled = false;
  }
}

async function startSelectedRun() {
  const run = selectedRun();
  if (!run) {
    showToast("请先选择一个流水线");
    return;
  }

  els.startNode.disabled = true;
  try {
    await submitIdeSupplement(run);
    const data = await api(`/api/workflows/${encodeURIComponent(run.id)}/start`, {
      method: "POST",
      body: JSON.stringify({})
    });

    const runIndex = state.runs.findIndex((item) => item.id === data.run.id);
    if (runIndex >= 0) state.runs[runIndex] = data.run;
    if (data.bug) {
      const bugIndex = state.bugs.findIndex((item) => item.id === data.bug.id);
      if (bugIndex >= 0) state.bugs[bugIndex] = data.bug;
    }
    render();
    configurePolling();
    showToast(`已在页面后台启动 ${ideExecutorLabel(run)}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    els.startNode.disabled = false;
  }
}

async function submitIdeSupplement(run) {
  const text = els.ideSupplementText.value.trim();
  const files = Array.from(els.ideSupplementImages.files || []);
  if (!text && !files.length) return;

  if (files.length > 8) {
    throw new Error("补充图片最多 8 张");
  }

  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      throw new Error(`只支持上传图片：${file.name}`);
    }
    if (file.size > 10 * 1024 * 1024) {
      throw new Error(`图片超过 10MB：${file.name}`);
    }
  }

  const form = new FormData();
  form.append("text", text);
  files.forEach((file) => form.append("images", file, file.name));

  els.ideSupplementState.textContent = "保存中";
  const data = await api(`/api/workflows/${encodeURIComponent(run.id)}/supplement`, {
    method: "POST",
    body: form
  });

  const runIndex = state.runs.findIndex((item) => item.id === data.run.id);
  if (runIndex >= 0) state.runs[runIndex] = data.run;
  if (data.bug) {
    const bugIndex = state.bugs.findIndex((item) => item.id === data.bug.id);
    if (bugIndex >= 0) state.bugs[bugIndex] = data.bug;
  }

  els.ideSupplementText.value = "";
  els.ideSupplementImages.value = "";
  updateSupplementFileState();
  els.ideSupplementState.textContent = "已保存";
  render();
}

async function startSelectedReview() {
  const run = selectedRun();
  if (!run) {
    showToast("请先选择一个流水线");
    return;
  }

  els.startReview.disabled = true;
  try {
    const data = await api(`/api/workflows/${encodeURIComponent(run.id)}/review/start`, {
      method: "POST",
      body: JSON.stringify({})
    });

    const runIndex = state.runs.findIndex((item) => item.id === data.run.id);
    if (runIndex >= 0) state.runs[runIndex] = data.run;
    if (data.bug) {
      const bugIndex = state.bugs.findIndex((item) => item.id === data.bug.id);
      if (bugIndex >= 0) state.bugs[bugIndex] = data.bug;
    }
    render();
    configurePolling();
    showToast("已启动独立 Review 会话");
  } catch (error) {
    showToast(error.message);
  } finally {
    els.startReview.disabled = false;
  }
}

async function startSelectedVerification() {
  const run = selectedRun();
  if (!run) {
    showToast("请先选择一个流水线");
    return;
  }

  els.startVerify.disabled = true;
  try {
    const data = await api(`/api/workflows/${encodeURIComponent(run.id)}/verify/start`, {
      method: "POST",
      body: JSON.stringify({})
    });

    const runIndex = state.runs.findIndex((item) => item.id === data.run.id);
    if (runIndex >= 0) state.runs[runIndex] = data.run;
    if (data.bug) {
      const bugIndex = state.bugs.findIndex((item) => item.id === data.bug.id);
      if (bugIndex >= 0) state.bugs[bugIndex] = data.bug;
    }
    render();
    configurePolling();
    showToast(isVerificationRunning(data.run) ? "已启动 npm run dev，请人工验证" : (data.run.validation?.notes || "验证启动未成功"));
  } catch (error) {
    showToast(error.message);
  } finally {
    els.startVerify.disabled = false;
  }
}

async function completeSelectedNode(status) {
  const run = selectedRun();
  const node = selectedNode();
  if (!run || !node) {
    showToast("请先选择一个流水线节点");
    return;
  }

  try {
    const data = await api(`/api/workflows/${encodeURIComponent(run.id)}/nodes/${encodeURIComponent(node.id)}/complete`, {
      method: "POST",
      body: JSON.stringify({ status })
    });

    const runIndex = state.runs.findIndex((item) => item.id === data.run.id);
    if (runIndex >= 0) state.runs[runIndex] = data.run;
    if (data.bug) {
      const bugIndex = state.bugs.findIndex((item) => item.id === data.bug.id);
      if (bugIndex >= 0) state.bugs[bugIndex] = data.bug;
    }
    render();
    showToast(status === "done" ? "节点已标记完成" : "节点已标记需复核");
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshAssignmentRecommendation() {
  const bug = selectedBug();
  if (!bug) {
    showToast("请先选择一个缺陷");
    return;
  }

  try {
    const data = await api(`/api/bugs/${encodeURIComponent(bug.id)}/assignment/recommend`, {
      method: "POST",
      body: JSON.stringify({})
    });
    replaceBug(data.bug);
    render();
    showToast("已重新生成分配建议");
  } catch (error) {
    showToast(error.message);
  }
}

async function applyAssignmentRecommendation() {
  const bug = selectedBug();
  const recommendation = bug?.assignmentRecommendation;
  if (!bug || !recommendation?.assigneeId) {
    showToast("当前缺陷没有可用分配建议");
    return;
  }

  const ok = window.confirm(`确认将 ${bug.code} 分配给 ${recommendation.assigneeName}（${recommendation.assigneeId}）？`);
  if (!ok) return;

  try {
    const data = await api(`/api/bugs/${encodeURIComponent(bug.id)}/assignment/apply`, {
      method: "POST",
      body: JSON.stringify({ assigneeId: recommendation.assigneeId })
    });
    replaceBug(data.bug);
    render();
    showToast(`已分配给 ${recommendation.assigneeName}`);
  } catch (error) {
    if (error.data?.bug) {
      replaceBug(error.data.bug);
      render();
    }
    showToast(error.message);
  }
}

async function applyAllAssignments() {
  const candidates = assignmentCandidates();
  if (!candidates.length) {
    showToast("当前没有待分配的推荐任务");
    return;
  }

  const ok = window.confirm(`确认按 AI 推荐结果一键分配 ${candidates.length} 条任务？`);
  if (!ok) return;

  els.assignAll.disabled = true;
  try {
    const data = await api("/api/assignments/apply-all", {
      method: "POST",
      body: JSON.stringify({})
    });
    applyBootstrap(data);
    const result = data.result;
    showToast(`一键分配完成：成功 ${result.success} 条${result.failed ? `，失败 ${result.failed} 条` : ""}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    renderScheduler();
  }
}

function replaceBug(bug) {
  const index = state.bugs.findIndex((item) => item.id === bug.id);
  if (index >= 0) state.bugs[index] = bug;
}

async function copyTaskPacket() {
  const text = els.taskPacket.textContent;
  try {
    await navigator.clipboard.writeText(text);
    showToast("任务包已复制");
  } catch {
    showToast("当前浏览器不允许自动复制，可手动选择任务包文本");
  }
}

async function copyIdeCommand() {
  const run = selectedRun();
  const command = run?.codexHandoff?.command;
  if (!command) {
    showToast("请先生成 IDE 任务");
    return;
  }

  try {
    await navigator.clipboard.writeText(command);
    showToast(`${ideExecutorLabel(run)} 命令已复制`);
  } catch {
    showToast("当前浏览器不允许自动复制，可手动选择命令文本");
  }
}

async function loadBugAttachments(bugId) {
  const bug = state.bugs.find((item) => item.id === bugId);
  if (!bug || bug.attachmentsLoaded || attachmentRequests.has(bug.id)) return;

  attachmentRequests.add(bug.id);
  bug.attachmentsLoading = true;
  bug.attachmentsError = "";
  renderBugDetail();

  try {
    const data = await api(`/api/bugs/${encodeURIComponent(bug.id)}/attachments`);
    const current = state.bugs.find((item) => item.id === data.bugId);
    if (current) {
      current.attachments = data.attachments || [];
      current.attachmentsLoaded = true;
      current.attachmentsError = "";
    }
  } catch (error) {
    const current = state.bugs.find((item) => item.id === bug.id);
    if (current) {
      current.attachmentsError = error.message;
      current.attachmentsLoaded = false;
    }
  } finally {
    const current = state.bugs.find((item) => item.id === bug.id);
    if (current) current.attachmentsLoading = false;
    attachmentRequests.delete(bug.id);
    renderBugDetail();
  }
}

function render() {
  renderPermissions();
  renderPages();
  renderAssigneeOptions();
  fillConfigForm();
  renderCredentials();
  renderMetrics();
  renderScheduler();
  renderAssignmentPeople();
  renderBugList();
  renderBugDetail();
  renderPipeline();
  renderPermissions();
}

function renderAssigneeOptions() {
  if (!els.assigneeSelect) return;
  const seen = new Set();
  const people = (state.assignmentPeople || []).filter((person) => {
    const employeeId = String(person.employeeId || "").trim();
    if (!employeeId || seen.has(employeeId)) return false;
    seen.add(employeeId);
    return true;
  });

  const currentAssignee = String(state.config.assignee || "");
  els.assigneeSelect.innerHTML = `<option value="">选择员工</option>${people.map((person) => {
    const selected = person.employeeId === currentAssignee ? "selected" : "";
    const responsibility = person.responsibility ? ` · ${escapeHtml(person.responsibility)}` : "";
    return `<option value="${escapeHtml(person.employeeId)}" ${selected}>${escapeHtml(person.name)}（${escapeHtml(person.employeeId)}）${responsibility}</option>`;
  }).join("")}`;
}

function renderPages() {
  document.body.dataset.view = state.view;
  document.querySelectorAll("[data-page]").forEach((page) => {
    page.hidden = page.dataset.page !== state.view;
  });

  document.querySelectorAll("[data-nav]").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === state.view);
  });
}

function fillConfigForm() {
  els.configForm.elements.codexWorkspaceDir.readOnly = Boolean(state.config.workspaceManaged);
  document.querySelector("#workspacePolicy").hidden = !state.config.workspaceManaged;
  if (configFormDirty) return;

  const fields = ["baseUrl", "lineId", "filterId", "assignee", "operatorId", "ideExecutor", "codexWorkspaceDir", "codexModel", "claudeModel", "codexReasoningEffort", "codexBaseBranch", "allowedAutoFixPriorities", "aiAssignmentModel", "aiRoutingModel", "aiRoutingBaseUrl", "aiRoutingTimeoutMs", "intervalMinutes", "pageSize", "maxPages", "requestDelayMs", "rateLimitRetryMs", "codexReviewMaxRounds"];
  fields.forEach((field) => {
    const value = state.config[field];
    if (els.configForm.elements[field]) {
      els.configForm.elements[field].value = Array.isArray(value) ? value.join(",") : value ?? "";
    }
  });
  els.configForm.elements.selfOnly.checked = Boolean(state.config.selfOnly);
  els.configForm.elements.enableBugInfoCompletion.checked = state.config.enableBugInfoCompletion !== false;
  els.configForm.elements.allowSkipInfoCompletion.checked = state.config.allowSkipInfoCompletion !== false;
  els.configForm.elements.enableAIRouting.checked = state.config.enableAIRouting !== false;
  els.configForm.elements.enableAIAssignment.checked = state.config.enableAIAssignment !== false;
  els.configForm.elements.enableAutoAssignment.checked = Boolean(state.config.enableAutoAssignment);
  els.configForm.elements.requireVerificationReport.checked = state.config.requireVerificationReport !== false;
  els.configForm.elements.requireRegressionTest.checked = Boolean(state.config.requireRegressionTest);
  els.configForm.elements.requireHumanReview.checked = state.config.requireHumanReview !== false;
  updateIdeModelFields(state.config.ideExecutor || "codex");
  syncIdeExecutorPicker();
}

function updateIdeModelFields(executor) {
  const selected = executor === "claude" ? "claude" : "codex";
  document.querySelectorAll("[data-ide-model]").forEach((field) => {
    field.hidden = field.dataset.ideModel !== selected;
  });
}

function syncIdeExecutorPicker() {
  if (!els.ideExecutorPicker) return;
  const executor = state.config.ideExecutor || "codex";
  els.ideExecutorPicker.value = executor;
}

function ideExecutorLabel(runOrExecutor) {
  const executor = typeof runOrExecutor === "string"
    ? runOrExecutor
    : (runOrExecutor?.ideExecutor || runOrExecutor?.codexHandoff?.executor || state.config.ideExecutor || "codex");
  return executor === "claude" ? "Claude Code" : "Codex";
}

function renderCredentials() {
  const ok = state.config.issueSourceConfigured;
  const aiOk = Boolean(state.config.aiRoutingKeyConfigured);
  els.credentialState.textContent = `${state.config.issueSourceLabel} · ${ok ? "服务端已配置凭据" : "服务端未配置凭据"} · AI 路由 ${aiOk ? "已配置 Key" : "未配置 Key"}`;
  els.sidebarCredentialDot.classList.toggle("ok", ok && aiOk);
  els.sidebarCredentialText.textContent = ok ? `${state.config.issueSourceLabel} 已配置 · AI ${aiOk ? "已配置" : "未配置"}` : "服务端未配置数据源凭据";
}

function renderMetrics() {
  setText("#metricTotal", state.metrics.total ?? 0);
  setText("#metricPending", state.metrics.pending ?? 0);
  setText("#metricProcessing", state.metrics.processing ?? 0);
  setText("#metricResolved", state.metrics.resolved ?? 0);
}

function renderScheduler() {
  const statusMap = {
    idle: "尚未同步",
    running: "同步中",
    success: "同步成功",
    error: "同步失败"
  };
  const next = state.scheduler.nextRunAt ? ` · 下次 ${formatDate(state.scheduler.nextRunAt)}` : "";
  els.syncState.textContent = `${statusMap[state.scheduler.lastRunStatus] || "未知"}${next}`;
  els.toggleScheduler.textContent = state.scheduler.enabled ? "关闭定时" : "开启定时";
  const candidates = assignmentCandidates();
  const assigning = state.bugs.some((bug) => bug.assignmentRecommendation?.status === "assigning");
  els.assignAll.disabled = assigning || candidates.length === 0;
  els.assignAll.textContent = assigning ? "分配中" : `一键分配${candidates.length ? `（${candidates.length}）` : ""}`;
}

function renderAssignmentPeople() {
  if (!els.assignmentPeopleList) return;
  const people = state.assignmentPeople || [];
  els.assignmentPeopleState.textContent = `${people.length} 人`;

  if (!people.length) {
    els.assignmentPeopleList.innerHTML = `<div class="empty">暂无人员规则，请添加一个可分配人员。</div>`;
    return;
  }

  els.assignmentPeopleList.innerHTML = people.map((person) => `
    <article class="assignment-person" data-person-id="${escapeHtml(person.employeeId)}">
      <div class="assignment-person-fields">
        <label>
          <span>姓名</span>
          <input name="personName" autocomplete="off" value="${escapeHtml(person.name)}" />
        </label>
        <label>
          <span>员工号</span>
          <input name="personEmployeeId" autocomplete="off" value="${escapeHtml(person.employeeId)}" />
        </label>
        <label class="wide-field">
          <span>职责</span>
          <textarea name="personResponsibility" rows="3">${escapeHtml(person.responsibility)}</textarea>
        </label>
      </div>
      <div class="assignment-person-actions">
        <button class="button secondary" type="button" data-save-person="${escapeHtml(person.employeeId)}">保存</button>
        <button class="button ghost danger" type="button" data-delete-person="${escapeHtml(person.employeeId)}">删除</button>
      </div>
    </article>
  `).join("");
}

function renderBugList() {
  if (!state.bugs.length) {
    els.bugList.innerHTML = `<div class="empty">暂无缺陷，点击“立即拉取”。</div>`;
    return;
  }

  els.bugList.innerHTML = statusGroups(state.bugs)
    .filter((group) => group.items.length)
    .map(
      (group) => `
        <section class="bug-status-group">
          <div class="bug-status-heading">
            <span>${escapeHtml(group.label)}</span>
            <strong>${group.items.length}</strong>
          </div>
          <div class="bug-status-items">
            ${group.items.map(renderBugItem).join("")}
          </div>
        </section>
      `
    )
    .join("");
}

function renderBugItem(bug) {
  const active = bug.id === state.selectedBugId ? "active" : "";
  return `
    <button class="bug-item ${active}" type="button" data-bug-id="${escapeHtml(bug.id)}">
      <span class="bug-code">${escapeHtml(bug.code)}</span>
      <span class="bug-title">${escapeHtml(bug.title)}</span>
      <span class="tag-row">
        <span class="tag status-${statusGroupKey(bug.status)}">${escapeHtml(bug.status || "未知状态")}</span>
        <span class="tag ${tagClass(bug.priority)}">${escapeHtml(bug.priority)}</span>
        <span class="tag ${tagClass(bug.severity)}">${escapeHtml(bug.severity)}</span>
        <span class="tag ${tagClass(bug.automationState)}">${stateText(bug.automationState)}</span>
        ${bug.assignmentRecommendation?.status === "pending" ? `<span class="tag assignment-pending">分配中</span>` : ""}
        ${bug.assignmentRecommendation?.assigneeName ? `<span class="tag assignment">荐 ${escapeHtml(bug.assignmentRecommendation.assigneeName)}</span>` : ""}
      </span>
    </button>
  `;
}

function statusGroups(bugs) {
  const groups = [
    { key: "pending", label: "未处理", items: [] },
    { key: "processing", label: "处理中", items: [] },
    { key: "resolved", label: "已解决", items: [] },
    { key: "other", label: "其他状态", items: [] }
  ];
  const byKey = Object.fromEntries(groups.map((group) => [group.key, group]));

  for (const bug of bugs) {
    byKey[statusGroupKey(bug.status)].items.push(bug);
  }

  return groups;
}

function renderBugDetail() {
  const bug = selectedBug();
  if (!bug) {
    els.selectedState.textContent = "未选择";
    els.bugDetail.innerHTML = `<div class="empty">从左侧选择一个缺陷。</div>`;
    return;
  }

  els.selectedState.textContent = `${bug.status || "未知状态"} · ${formatDateText(bug.updatedAt)}`;
  els.bugDetail.innerHTML = `
    <div class="detail-heading">
      <span class="bug-code">${escapeHtml(bug.code)}</span>
      <strong>${escapeHtml(bug.title)}</strong>
      <div class="tag-row">
        <span class="tag">${escapeHtml(bug.product || "未指定产品")}</span>
        <span class="tag">${escapeHtml(bug.category || "未指定分类")}</span>
        <span class="tag">${escapeHtml(bug.assignee || "未指定经办人")}</span>
      </div>
    </div>
    <div class="detail-section">
      <h3>描述</h3>
      ${renderDescription(bug.description)}
    </div>
    <div class="detail-section">
      <h3>复现步骤</h3>
      <ol>${(bug.reproduceSteps || []).map((step) => `<li>${escapeHtml(step)}</li>`).join("") || "<li>未提供复现步骤</li>"}</ol>
    </div>
    <div class="detail-section">
      <h3>验收</h3>
      <p>期望：${escapeHtml(bug.expected || "")}</p>
      <p>实际：${escapeHtml(bug.actual || "")}</p>
    </div>
    <div class="detail-section">
      <h3>Codex 提示</h3>
      <p>${escapeHtml(bug.repositoryHint || "让 Codex 自动搜索相关模块。")} · ${escapeHtml(bug.testHint || "按仓库测试脚本验证。")}</p>
    </div>
    <div class="detail-section">
      <h3>AI 分配建议</h3>
      ${renderAssignmentRecommendation(bug)}
    </div>
    <div class="detail-section">
      <h3>附件</h3>
      ${renderAttachments(bug)}
    </div>
  `;
}

function renderDescription(value) {
  const raw = String(value || "").trim();
  if (!raw) return `<p class="muted-text">未提供描述。</p>`;
  if (!/<[a-z][\s\S]*>/i.test(raw)) {
    return `<div class="description-content">${escapeHtml(raw).replace(/\r?\n/g, "<br>")}</div>`;
  }

  const documentNode = new DOMParser().parseFromString(raw, "text/html");
  const content = Array.from(documentNode.body.childNodes).map(renderDescriptionNode).join("");
  return `<div class="description-content">${content || escapeHtml(raw)}</div>`;
}

function renderDescriptionNode(node) {
  if (node.nodeType === 3) return escapeHtml(node.textContent || "");
  if (node.nodeType !== 1) return "";

  const tag = node.tagName.toLowerCase();
  const children = Array.from(node.childNodes).map(renderDescriptionNode).join("");
  if (tag === "img") {
    const src = safeDescriptionImageUrl(node.getAttribute("src"));
    if (!src) return "";
    const alt = escapeHtml(node.getAttribute("alt") || "缺陷描述图片");
    const href = escapeHtml(src);
    return `
      <a class="description-image-link" href="${href}" target="_blank" rel="noopener noreferrer">
        <img class="description-image" src="${href}" alt="${alt}" decoding="async" />
      </a>
    `;
  }

  if (tag === "br") return "<br>";
  if (tag === "a") {
    if (node.querySelector("img")) return children;
    const href = safeDescriptionLinkUrl(node.getAttribute("href"));
    return href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${children}</a>`
      : children;
  }

  const allowedTags = new Set(["p", "div", "ul", "ol", "li", "strong", "b", "em", "i", "code", "pre"]);
  return allowedTags.has(tag) ? `<${tag}>${children}</${tag}>` : children;
}

function safeDescriptionImageUrl(value) {
  const raw = String(value || "").trim();
  if (!/^(https?:)?\/\//i.test(raw)) return "";
  return safeDescriptionLinkUrl(raw);
}

function safeDescriptionLinkUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim(), window.location.href);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

function renderAssignmentRecommendation(bug) {
  const recommendation = bug.assignmentRecommendation;
  const assignable = isAssignableBugStatus(bug.status);
  if (!assignable) {
    return `<p class="muted-text">仅待处理和处理中的缺陷需要分配，当前状态为：${escapeHtml(bug.status || "未知")}。</p>`;
  }

  if (!recommendation) {
    return `
      <p class="muted-text">尚未生成分配建议。</p>
      <div class="panel-actions inline-actions">
        <button class="button ghost" type="button" data-assignment-recommend>生成建议</button>
      </div>
    `;
  }

  if (recommendation.status === "pending") {
    return `<p class="muted-text">${escapeHtml(recommendation.reason || "AI 分配建议后台生成中。")}</p>`;
  }

  if (recommendation.status === "assigning") {
    return `<p class="muted-text">正在分配给 ${escapeHtml(recommendation.assigneeName || recommendation.assigneeId || "推荐人")}。</p>`;
  }

  if (recommendation.status === "error" || recommendation.status === "assign-failed") {
    return `
      <p class="error-text">${escapeHtml(recommendation.error || "分配建议生成失败。")}</p>
      <div class="panel-actions inline-actions">
        <button class="button ghost" type="button" data-assignment-recommend>重新生成</button>
        ${recommendation.assigneeId ? `<button class="button secondary" type="button" data-assignment-apply>重新尝试分配</button>` : ""}
      </div>
    `;
  }

  if (recommendation.status === "skipped") {
    return `
      <p class="muted-text">${escapeHtml(recommendation.reason || "AI 分配建议已关闭。")}</p>
      <div class="panel-actions inline-actions">
        <button class="button ghost" type="button" data-assignment-recommend>手动生成</button>
      </div>
    `;
  }

  const assigned = recommendation.status === "assigned" || recommendation.assigned;
  return `
    <p>推荐：<strong>${escapeHtml(recommendation.assigneeName || "")}</strong>（${escapeHtml(recommendation.assigneeId || "")}） · 置信度：${escapeHtml(recommendation.confidence || "unknown")}</p>
    <p>职责：${escapeHtml(recommendation.matchedResponsibility || "")}</p>
    <p>原因：${escapeHtml(recommendation.reason || "")}</p>
    <p>状态：${escapeHtml(assigned ? `已分配 ${formatDateText(recommendation.assignedAt)}` : "待人工确认")}</p>
    <div class="panel-actions inline-actions">
      <button class="button ghost" type="button" data-assignment-recommend>重新生成</button>
      <button class="button secondary" type="button" data-assignment-apply ${assigned ? "disabled" : ""}>分配给推荐人</button>
    </div>
  `;
}

function isAssignableBugStatus(status) {
  return ["pending", "processing"].includes(statusGroupKey(status));
}

function assignmentCandidates() {
  return state.bugs.filter((bug) => {
    const recommendation = bug.assignmentRecommendation;
    return isAssignableBugStatus(bug.status)
      && Boolean(recommendation?.assigneeId)
      && !recommendation.assigned
      && ["ready", "assign-failed"].includes(recommendation.status);
  });
}

function renderAttachments(bug) {
  if (bug.attachmentsLoading) {
    return `<p class="muted-text">正在加载附件...</p>`;
  }

  if (bug.attachmentsError) {
    return `<p class="error-text">${escapeHtml(bug.attachmentsError)}</p>`;
  }

  if (!bug.attachmentsLoaded) {
    return `<p class="muted-text">选择缺陷后自动加载附件。</p>`;
  }

  if (!bug.attachments?.length) {
    return `<p class="muted-text">暂无附件。</p>`;
  }

  return `
    <div class="attachment-list">
      ${bug.attachments.map(renderAttachment).join("")}
    </div>
  `;
}

function renderAttachment(attachment, index) {
  const size = formatBytes(attachment.size);
  const meta = [size, attachment.ctimeStr, attachment.creator].filter(Boolean).join(" · ");
  const name = escapeHtml(attachment.name || "未命名附件");
  const href = safeDescriptionLinkUrl(attachment.url);
  const previewUrl = safeDescriptionImageUrl(attachment.url || attachment.thumbnailUrl);
  const canPreview = Boolean(previewUrl && isImageAttachment(attachment));
  const nameControl = canPreview
    ? `<button class="attachment-name attachment-preview-trigger" type="button" data-attachment-preview="${index}">${name}</button>`
    : href
      ? `<a class="attachment-name" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${name}</a>`
      : `<strong class="attachment-name">${name}</strong>`;

  return `
    <div class="attachment-item">
      <div class="attachment-main">
        ${nameControl}
        <span>${escapeHtml(meta || attachment.aid || "")}</span>
      </div>
      ${href ? `<a class="attachment-download" href="${escapeHtml(href)}" download="${name}">下载</a>` : ""}
    </div>
  `;
}

function isImageAttachment(attachment) {
  const name = String(attachment?.name || "");
  const contentType = String(attachment?.contentType || attachment?.mimeType || "");
  return contentType.startsWith("image/")
    || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name);
}

function openAttachmentPreview(index) {
  const attachment = selectedBug()?.attachments?.[index];
  const src = safeDescriptionImageUrl(attachment?.url || attachment?.thumbnailUrl);
  if (!attachment || !src || !isImageAttachment(attachment)) {
    showToast("当前附件无法预览");
    return;
  }

  const name = attachment.name || "图片预览";
  els.attachmentPreviewTitle.textContent = name;
  els.attachmentPreviewImage.alt = name;
  els.attachmentPreviewState.hidden = false;
  els.attachmentPreviewState.textContent = "图片加载中";
  const downloadUrl = safeDescriptionLinkUrl(attachment.url || src);
  els.attachmentPreviewDownload.href = downloadUrl;
  els.attachmentPreviewDownload.download = name;
  els.attachmentPreviewModal.hidden = false;
  document.body.classList.add("preview-open");
  els.attachmentPreviewClose.focus();
  els.attachmentPreviewImage.src = src;
}

function closeAttachmentPreview() {
  els.attachmentPreviewModal.hidden = true;
  els.attachmentPreviewImage.removeAttribute("src");
  els.attachmentPreviewState.hidden = false;
  document.body.classList.remove("preview-open");
}

function renderPipeline() {
  const run = selectedRun();
  if (run && state.selectedRunId !== run.id) {
    state.selectedRunId = run.id;
  }
  renderPipelineBugList();
  renderRunList();
  renderExecutionRecords();

  if (!run) {
    els.runState.textContent = "等待创建";
    els.runState.className = "github-status-pill pending";
    if (els.pipelineNodeCount) els.pipelineNodeCount.textContent = "0 个节点";
    els.pipelineSteps.innerHTML = `<div class="empty">选择缺陷后创建人工或自动流水线。</div>`;
    els.nodeDetail.innerHTML = `<div class="empty">创建流水线后可以查看每个节点。</div>`;
    els.startNode.hidden = true;
    els.startReview.hidden = true;
    els.startVerify.hidden = true;
    els.stopNode.hidden = true;
    els.completeNode.hidden = true;
    els.reviewNode.hidden = true;
    els.logBox.textContent = "暂无日志";
    els.taskPacket.textContent = "选择缺陷并创建流水线。";
    els.handoffMeta.hidden = true;
    els.handoffMeta.innerHTML = "";
    els.ideSupplementPanel.hidden = true;
    return;
  }

  if (!run.steps.some((step) => step.id === state.selectedNodeId)) {
    state.selectedNodeId = run.steps[0]?.id || "pull";
  }

  els.runState.textContent = runStatusText(run.status);
  els.runState.className = `github-status-pill ${tagClass(run.status)}`;
  if (els.pipelineNodeCount) els.pipelineNodeCount.textContent = `${run.steps.length} 个节点`;
  els.pipelineSteps.innerHTML = run.steps.map(renderNodeItem).join("");
  els.logBox.textContent = run.logs.join("\n");
  els.taskPacket.textContent = run.taskPacket;
  renderHandoffMeta(run);
  renderNodeDetail(run);
  renderIdeSupplementPanel(run);
}

function renderPipelineBugList() {
  if (!state.bugs.length) {
    els.pipelineBugList.innerHTML = `<div class="empty compact-empty">暂无缺陷，点击“立即拉取”。</div>`;
    return;
  }

  els.pipelineBugList.innerHTML = state.bugs.map((bug) => {
    const active = bug.id === state.selectedBugId ? "active" : "";
    const bugRuns = runsForBug(bug.id);
    const latestRun = bugRuns[0];
    const runText = latestRun ? `最近运行 · ${formatDateText(latestRun.startedAt)}` : "暂无运行记录";
    return `
      <button class="pipeline-bug-item ${active}" type="button" data-pipeline-bug-id="${escapeHtml(bug.id)}">
        <div class="github-item-heading">
          <strong>${escapeHtml(bug.code)}</strong>
          <span class="github-item-state">${escapeHtml(latestRun ? runStatusText(latestRun.status) : "未运行")}</span>
        </div>
        <span>${escapeHtml(bug.title)}</span>
        <small>${escapeHtml(runText)}</small>
      </button>
    `;
  }).join("");
}

function renderRunList() {
  const runs = runsForBug(state.selectedBugId);
  if (!selectedBug()) {
    els.runList.innerHTML = `<div class="empty compact-empty">请选择缺陷。</div>`;
    return;
  }

  if (!runs.length) {
    els.runList.innerHTML = `<div class="empty compact-empty">当前缺陷暂无流水线。</div>`;
    return;
  }

  els.runList.innerHTML = runs.map((run) => {
    const active = run.id === state.selectedRunId ? "active" : "";
    return `
      <button class="run-item ${active}" type="button" data-run-id="${escapeHtml(run.id)}">
        <div class="github-item-heading">
          <strong>${escapeHtml(run.bugCode)}</strong>
          <span class="github-item-state ${escapeHtml(tagClass(run.status))}">${escapeHtml(runStatusText(run.status))}</span>
        </div>
        <span>${escapeHtml(run.executionMode === "auto" ? "自动执行" : "人工执行")} · ${escapeHtml(ideExecutorLabel(run))}</span>
        <small>${escapeHtml(formatDateText(run.startedAt))}</small>
      </button>
    `;
  }).join("");
}

function renderExecutionRecords() {
  if (els.executionRecordUser) {
    els.executionRecordUser.textContent = state.storageUserKey ? `用户 ${state.storageUserKey}` : "";
  }

  if (!els.executionRecordList) return;

  const records = recordsForView();
  if (els.executionRecordCount) els.executionRecordCount.textContent = String(records.length);
  if (els.executionRecordRunCount) {
    els.executionRecordRunCount.textContent = String(new Set(records.map((record) => record.runId).filter(Boolean)).size);
  }
  if (!records.length) {
    els.executionRecordList.innerHTML = `<div class="empty compact-empty">暂无执行记录。</div>`;
    return;
  }

  els.executionRecordList.innerHTML = records.map((record) => {
    const linkable = Boolean(record.runId && state.runs.some((run) => run.id === record.runId));
    return `
      <button class="execution-record-item ${linkable ? "linkable" : ""}" type="button" data-record-id="${escapeHtml(record.id || "")}" data-record-run-id="${escapeHtml(record.runId || "")}" ${linkable ? "" : "disabled"}>
        <span class="github-event-dot" aria-hidden="true"></span>
        <div>
          <strong>${escapeHtml(executionEventText(record.event))}</strong>
          <span>${escapeHtml(record.bugCode || "—")} · ${escapeHtml(record.message || "")}</span>
          <small>${escapeHtml(formatDateText(record.at))}</small>
        </div>
        <span class="record-open" aria-hidden="true">→</span>
      </button>
    `;
  }).join("");
}

function recordsForView() {
  const records = state.executionRecords || [];
  return records.slice(0, 100);
}

function executionEventText(event) {
  return {
    "run-created": "创建流水线",
    "run-started": "启动执行",
    "run-completed": "执行完成",
    "run-awaiting-review": "待人工 Review",
    "run-stopped": "停止执行",
    "run-failed": "执行失败",
    "run-supplemented": "补充信息",
    "node-completed": "节点完成",
    "bugs-synced": "缺陷同步",
    "bugs-synced-incremental": "增量同步",
    "bug-assigned": "缺陷分配",
    "bug-assignment-failed": "缺陷分配失败",
    "assignment-batch-completed": "批量分配",
    "user-switched": "切换用户",
    "config-updated": "配置更新"
  }[event] || event || "事件";
}

function renderNodeItem(step) {
  const active = step.id === state.selectedNodeId ? "active" : "";
  return `
    <button class="step ${escapeHtml(step.status)} ${active}" type="button" data-node-id="${escapeHtml(step.id)}">
      <span class="step-dot"></span>
      <div>
        <div class="step-title-row">
          <strong>${escapeHtml(step.label)}</strong>
          <span class="step-state">${escapeHtml(nodeStatusText(step.status))}</span>
        </div>
        <span>${escapeHtml(step.message)}</span>
      </div>
    </button>
  `;
}

function renderNodeDetail(run) {
  const node = selectedNode();
  if (!node) {
    els.nodeDetail.innerHTML = `<div class="empty">请选择一个节点。</div>`;
    return;
  }

  const codexRunning = isCodexRunning(run);
  const canStart = isIdeNodeId(node.id)
    && !codexRunning
    && run.routing?.ideAutofixAllowed !== false
    && !["awaiting-review", "reviewed", "closed"].includes(run.status);
  const canReview = node.id === "humanReview" && ["ready", "attention"].includes(node.status) && !codexRunning;
  const canRelease = node.id === "releaseClose" && ["ready", "attention"].includes(node.status) && !codexRunning;
  const canComplete = canReview || canRelease;
  const canStop = (isIdeNodeId(node.id) || node.id === "mergeDaily") && codexRunning;
  els.startNode.hidden = !canStart;
  els.startReview.hidden = true;
  els.startVerify.hidden = true;
  els.stopNode.hidden = !canStop;
  els.completeNode.hidden = !canComplete;
  els.reviewNode.hidden = !canComplete;
  els.startNode.textContent = "启动 IDE 任务";
  els.stopNode.textContent = "停止 IDE 任务";
  els.completeNode.textContent = node.id === "releaseClose" ? "确认关闭" : "Review 通过";
  els.reviewNode.textContent = node.id === "releaseClose" ? "暂不关闭" : "Review 驳回";
  els.nodeDetail.innerHTML = `
    <div class="detail-heading">
      <div class="github-node-path">${escapeHtml(run.bugCode)} / ${escapeHtml(node.id)}</div>
      <div class="github-node-title">
        <span class="github-node-status ${escapeHtml(node.status)}" aria-hidden="true"></span>
        <strong>${escapeHtml(node.label)}</strong>
      </div>
      <div class="tag-row github-metadata-row">
        <span class="tag ${tagClass(node.status)}">${escapeHtml(nodeStatusText(node.status))}</span>
        <span class="tag">${escapeHtml(ideExecutorLabel(run))}</span>
        <span class="tag">${escapeHtml(run.executionMode === "auto" ? "自动执行" : "人工执行")}</span>
      </div>
    </div>
    <div class="detail-section">
      <h3>节点说明</h3>
      <p>${escapeHtml(node.detail || node.message)}</p>
    </div>
    <div class="detail-section">
      <h3>当前输出</h3>
      <p>${escapeHtml(node.message)}</p>
    </div>
    ${isIdeNodeId(node.id) ? renderIdeDetail(run, node.id) : ""}
    ${node.id === "mergeDaily" ? renderMergeDetail(run) : ""}
    ${node.id === "handoff" ? renderCommandDetail(run) : ""}
    ${node.id === "infoCompletion" ? renderNormalizedBugDetail(run) : ""}
    ${node.id === "routing" ? renderRoutingDetail(run) : ""}
    ${node.id === "humanReview" ? renderHumanReviewDetail(run) : ""}
    ${node.id === "releaseClose" ? renderReleaseDetail(run) : ""}
    ${node.id === "normalize" ? renderNormalizedBugDetail(run) : ""}
    ${node.id === "review" ? renderReviewDetail(run) : ""}
    ${node.id === "verify" ? renderValidationDetail(run) : ""}
  `;
}

function isIdeNodeId(nodeId) {
  return ["analysis", "fixPlan", "codeFix", "autoTest", "verificationReport", "execute"].includes(nodeId);
}

function renderNormalizedBugDetail(run) {
  const normalized = run.normalizedBug;
  if (!normalized?.fields) {
    return `
      <div class="detail-section">
        <h3>缺陷信息模板</h3>
        <p>当前流水线未记录规范化信息。</p>
      </div>
    `;
  }

  return `
    <div class="detail-section">
      <h3>缺陷信息模板</h3>
      <pre class="inline-pre">${escapeHtml(formatNormalizedBug(normalized))}</pre>
    </div>
    <div class="detail-section">
      <h3>缺失字段</h3>
      <p>${escapeHtml(normalized.missing?.length ? normalized.missing.join("、") : "无")}</p>
    </div>
  `;
}

function renderRoutingDetail(run) {
  const route = run.routing;
  if (!route) {
    return `
      <div class="detail-section">
        <h3>路由结果</h3>
        <p>当前流水线未记录路由分类结果。</p>
      </div>
    `;
  }

  return `
    <div class="detail-section">
      <h3>路由结果</h3>
      <p>Bug 类型：${escapeHtml(route.bugType || "未知")}</p>
      <p>优先级：${escapeHtml(route.priority || "未知")}</p>
      <p>推荐处理：${escapeHtml(route.recommendedHandling || "未给出")}</p>
      <p>IDE 自主修复：${escapeHtml(route.ideAutofixAllowed ? "允许" : "不建议")}</p>
      <p>人工介入：${escapeHtml(route.needsHumanIntervention ? "需要" : "不强制")}</p>
      <p>原因：${escapeHtml(route.reason || "无")}</p>
    </div>
  `;
}

function renderIdeDetail(run, nodeId) {
  const reports = run.ide?.reports || {};
  const reportByNode = {
    analysis: {
      title: "Bug Analysis Report",
      value: reports.analysis,
      empty: "等待 IDE Agent 输出复现与根因分析。"
    },
    fixPlan: {
      title: "Fix Plan",
      value: reports.fixPlan,
      empty: "等待 IDE Agent 输出修改范围、修复思路、测试计划和回滚方式。"
    },
    codeFix: {
      title: "编码修复结果",
      value: reports.implementation,
      empty: "等待 IDE Agent 输出实际改动文件和实现摘要。"
    },
    autoTest: {
      title: "自动化测试结果",
      value: reports.automatedTests || reports.verification,
      empty: "等待 IDE Agent 输出测试命令、通过项和未通过项。"
    },
    verificationReport: {
      title: "Verification Report",
      value: reports.verification,
      empty: "等待 IDE Agent 输出验证结论和剩余风险。"
    }
  };
  const selectedReport = reportByNode[nodeId];

  return `
    ${renderProcessDetail(run)}
    ${renderBranchDetail(run)}
    ${selectedReport ? `
      <div class="detail-section node-report-section">
        <h3>${escapeHtml(selectedReport.title)}</h3>
        <pre class="inline-pre node-report-content">${escapeHtml(selectedReport.value || selectedReport.empty)}</pre>
      </div>
      ${nodeId === "verificationReport" ? `
        <div class="detail-section">
          <h3>剩余风险</h3>
          <p>${escapeHtml(reports.risks || "报告中未单独列出剩余风险。")}</p>
        </div>
      ` : ""}
    ` : renderAllIdeReports(reports)}
  `;
}

function renderAllIdeReports(reports) {
  return `
    <div class="detail-section">
      <h3>IDE 输出</h3>
      <p>根因分析：${escapeHtml(reports.analysis || "等待 IDE Agent 输出 Bug Analysis Report。")}</p>
      <p>修复方案：${escapeHtml(reports.fixPlan || "等待 IDE Agent 输出 Fix Plan。")}</p>
      <p>编码摘要：${escapeHtml(reports.implementation || "等待编码修复完成。")}</p>
      <p>测试结果：${escapeHtml(reports.automatedTests || reports.verification || "等待自动化测试结果。")}</p>
      <p>验证报告：${escapeHtml(reports.verification || "等待 Verification Report。")}</p>
      <p>剩余风险：${escapeHtml(reports.risks || "等待风险说明。")}</p>
    </div>
  `;
}

function renderIdeSupplementPanel(run) {
  const node = selectedNode();
  const codexRunning = isCodexRunning(run);
  const canShow = node
    && isIdeNodeId(node.id)
    && !codexRunning
    && run.routing?.ideAutofixAllowed !== false
    && !["awaiting-review", "reviewed", "closed"].includes(run.status);

  els.ideSupplementPanel.hidden = !canShow;
  if (!canShow) return;

  if (els.ideSupplementPanel.dataset.runId !== run.id) {
    els.ideSupplementPanel.dataset.runId = run.id;
    els.ideSupplementText.value = "";
    els.ideSupplementImages.value = "";
    updateSupplementFileState();
  }

  const supplement = run.ideSupplement || {};
  const imageCount = supplement.images?.length || 0;
  els.ideSupplementState.textContent = supplement.text || imageCount ? `已保存 ${imageCount} 张图片` : "可选";
  els.ideSupplementSaved.innerHTML = renderSavedSupplement(supplement);
}

function renderSavedSupplement(supplement) {
  if (!supplement?.text && !supplement?.images?.length) {
    return `<p class="muted-text">尚未保存补充信息。填写后点击“启动 IDE 任务”会先写入任务包。</p>`;
  }

  return `
    <div>
      <strong>已写入任务包</strong>
      ${supplement.savedAt ? `<span> · ${escapeHtml(formatDateText(supplement.savedAt))}</span>` : ""}
    </div>
    ${supplement.text ? `<p>${escapeHtml(supplement.text)}</p>` : ""}
    ${supplement.images?.length ? `
      <ul>
        ${supplement.images.map((image) => `
          <li>${escapeHtml(image.name || "图片")} · ${escapeHtml(image.localRelativePath || image.localPath || "")}</li>
        `).join("")}
      </ul>
    ` : ""}
  `;
}

function updateSupplementFileState() {
  const files = Array.from(els.ideSupplementImages.files || []);
  if (!files.length) {
    els.ideSupplementFileState.textContent = "最多 8 张，每张不超过 10MB。";
    return;
  }

  const total = files.reduce((sum, file) => sum + file.size, 0);
  els.ideSupplementFileState.textContent = `${files.length} 张 · ${formatBytes(total)}`;
}

function renderHumanReviewDetail(run) {
  const review = run.review || {};
  return `
    <div class="detail-section">
      <h3>Review 检查项</h3>
      <ul>
        <li>根因是否可信，证据是否充分</li>
        <li>修复方案是否合理，修改范围是否最小</li>
        <li>是否存在无关改动或绕过校验</li>
        <li>测试是否覆盖 Bug 场景和关键回归场景</li>
        <li>验证报告是否说明剩余风险和回滚方式</li>
      </ul>
    </div>
    <div class="detail-section">
      <h3>Review 结果</h3>
      <p>要求人工 Review：${escapeHtml(review.required === false ? "否" : "是")}</p>
      <p>结果：${escapeHtml(review.result || "pending")}</p>
      <p>说明：${escapeHtml(review.notes || "等待人工 Review。")}</p>
    </div>
  `;
}

function renderReleaseDetail(run) {
  const releaseClose = run.releaseClose || {};
  return `
    <div class="detail-section">
      <h3>发布确认</h3>
      <ul>
        <li>自动化测试通过或风险已明确</li>
        <li>人工 Review 通过</li>
        <li>风险说明完整，回滚方式明确</li>
        <li>工单回填根因、修复内容、验证方式、测试结果和后续观察项</li>
      </ul>
    </div>
    <div class="detail-section">
      <h3>关闭状态</h3>
      <p>${escapeHtml(releaseClose.notes || "等待人工 Review 通过后发布并关闭工单。")}</p>
    </div>
  `;
}

function renderReviewDetail(run) {
  const review = run.review || {};
  const process = review.process;
  return `
    <div class="detail-section">
      <h3>Review 配置</h3>
      <p>轮次：${escapeHtml(`${review.currentRound || 0}/${review.maxRounds || state.config.codexReviewMaxRounds || 3}`)}</p>
      <p>结果：${escapeHtml(review.passed ? "通过，等待人工验证" : review.notes || "等待 Review")}</p>
    </div>
    <div class="detail-section">
      <h3>当前进程</h3>
      <p>PID：${escapeHtml(process?.pid || "未启动")}</p>
      <p>阶段：${escapeHtml(process?.phase || "无")}</p>
      <p>状态：${escapeHtml(process?.status || "未启动")}</p>
      <p>退出码：${escapeHtml(process?.exitCode ?? "未结束")}</p>
    </div>
    <div class="detail-section">
      <h3>Review 记录</h3>
      ${renderReviewRounds(review.rounds || [])}
    </div>
  `;
}

function renderReviewRounds(rounds) {
  if (!rounds.length) {
    return `<p class="muted-text">暂无 Review 记录。</p>`;
  }

  return `
    <div class="review-rounds">
      ${rounds.map((round) => `
        <div class="review-round">
          <strong>第 ${escapeHtml(round.round)} 轮 · ${escapeHtml(round.status === "passed" ? "通过" : "要求修改")}</strong>
          <p>${escapeHtml(round.summary || "")}</p>
          <ul>
            ${(round.comments || []).map((comment) => `<li>${escapeHtml(comment)}</li>`).join("") || "<li>无</li>"}
          </ul>
        </div>
      `).join("")}
    </div>
  `;
}

function renderBranchDetail(run) {
  const executor = run.ideExecutor || run.codexHandoff?.executor || state.config.ideExecutor || "codex";
  const model = executor === "claude"
    ? (state.config.claudeModel || "claude-opus-4-8")
    : (state.config.codexModel || "gpt-5.6-sol");
  const effort = state.config.codexReasoningEffort || "medium";

  return `
    <div class="detail-section">
      <h3>Git 分支</h3>
      <p>Bug 分支：${escapeHtml(run.gitBranch || run.git?.branchName || "未生成")}</p>
      <p>当天验证分支：${escapeHtml(run.dailyBranch || run.git?.dailyBranchName || "执行完成后生成")}</p>
      <p>合并状态：${escapeHtml(run.git?.mergeStatus || "未合并")}</p>
      <p>主分支：${escapeHtml(run.git?.baseBranch || state.config.codexBaseBranch || "main")}</p>
      <p>原分支：${escapeHtml(run.git?.previousBranch || "未知")}</p>
    </div>
    <div class="detail-section">
      <h3>IDE 配置</h3>
      <p>执行器：${escapeHtml(ideExecutorLabel(executor))}</p>
      <p>模型：${escapeHtml(model)}</p>
      ${executor === "codex" ? `<p>推理强度：${escapeHtml(effort)}</p>` : ""}
    </div>
  `;
}

function renderMergeDetail(run) {
  return `
    ${renderBranchDetail(run)}
    <div class="detail-section">
      <h3>合并策略</h3>
      <p>每个 Bug 仍在独立 Bug 分支修复，修复完成后自动提交并合并到个人当天验证分支。</p>
      <p>冲突处理：${escapeHtml(run.git?.mergeConflict ? `已触发 ${ideExecutorLabel(run)} 冲突处理任务` : "无冲突或尚未执行")}</p>
      <p>冲突详情：${escapeHtml(run.git?.mergeConflict || "无")}</p>
    </div>
  `;
}

function renderProcessDetail(run) {
  const process = run.process || run.ide?.process;
  if (!process) {
    return `
      <div class="detail-section">
        <h3>IDE 进程</h3>
        <p>尚未启动。</p>
      </div>
    `;
  }

  return `
    <div class="detail-section">
      <h3>IDE 进程</h3>
      <p>PID：${escapeHtml(process.pid || "")}</p>
      <p>状态：${escapeHtml(process.status || "未知")}</p>
      <p>退出码：${escapeHtml(process.exitCode ?? "未结束")}</p>
    </div>
  `;
}

function renderCommandDetail(run) {
  const handoff = run.codexHandoff;
  if (!handoff) return "";
  return `
    <div class="detail-section">
      <h3>任务文件</h3>
      <p>${escapeHtml(handoff.taskPath)}</p>
    </div>
    <div class="detail-section">
      <h3>执行命令</h3>
      <p>${escapeHtml(handoff.command)}</p>
    </div>
  `;
}

function renderValidationDetail(run) {
  return `
    <div class="detail-section">
      <h3>验证命令</h3>
      <p>${escapeHtml(run.validation?.command || "按仓库约定执行")}</p>
    </div>
    <div class="detail-section">
      <h3>验证结果</h3>
      <p>${escapeHtml(run.validation?.notes || "等待验证。")}</p>
    </div>
    ${renderValidationProcessDetail(run)}
  `;
}

function renderValidationProcessDetail(run) {
  const process = run.validation?.process;
  if (!process) {
    return `
      <div class="detail-section">
        <h3>验证进程</h3>
        <p>尚未启动。</p>
      </div>
    `;
  }

  return `
    <div class="detail-section">
      <h3>验证进程</h3>
      <p>PID：${escapeHtml(process.pid || "")}</p>
      <p>状态：${escapeHtml(process.status || "未知")}</p>
      <p>退出码：${escapeHtml(process.exitCode ?? "未结束")}</p>
    </div>
  `;
}

function renderHandoffMeta(run) {
  const handoff = run.codexHandoff;
  if (!handoff) {
    els.handoffMeta.hidden = true;
    els.handoffMeta.innerHTML = "";
    return;
  }

  els.handoffMeta.hidden = false;
  els.handoffMeta.innerHTML = `
    <div>
      <span>任务文件</span>
      <strong>${escapeHtml(handoff.relativeTaskPath || handoff.taskPath)}</strong>
    </div>
    <div>
      <span>${escapeHtml(ideExecutorLabel(run))} CLI</span>
      <code>${escapeHtml(handoff.command)}</code>
    </div>
  `;
}

function configurePolling() {
  const hasRunning = state.runs.some((run) => ["running", "reviewing", "stopping", "validating"].includes(run.status) || isReviewRunning(run) || isVerificationRunning(run));
  const hasPendingAssignments = state.bugs.some((bug) => ["pending", "assigning"].includes(bug.assignmentRecommendation?.status));
  if ((hasRunning || hasPendingAssignments) && !pollTimer) {
    pollTimer = setInterval(() => loadBootstrap({ silent: true }).catch(() => {}), 3000);
  }

  if (!hasRunning && !hasPendingAssignments && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function selectedBug() {
  return state.bugs.find((bug) => bug.id === state.selectedBugId) || null;
}

function selectedRun() {
  const bug = selectedBug();
  if (!bug) return null;
  const preferredRunId = state.selectedRunId || bug.lastRunId;
  const preferredRun = state.runs.find((run) => run.id === preferredRunId && run.bugId === bug.id);
  return preferredRun || latestRunForBug(bug.id);
}

function selectedNode() {
  return selectedRun()?.steps.find((step) => step.id === state.selectedNodeId) || null;
}

function selectBug(bugId) {
  state.selectedBugId = bugId;
  state.selectedRunId = latestRunForBug(bugId)?.id || null;
  state.selectedNodeId = selectedRun()?.steps?.[0]?.id || "pull";
}

function runsForBug(bugId) {
  if (!bugId) return [];
  return state.runs.filter((run) => run.bugId === bugId);
}

function latestRunForBug(bugId) {
  return runsForBug(bugId)[0] || null;
}

function isCodexRunning(run) {
  return run?.process?.status === "running" || run?.ide?.process?.status === "running" || run?.status === "running";
}

function isReviewRunning(run) {
  return run?.status === "reviewing" || ["running", "stopping"].includes(run?.review?.process?.status);
}

function isVerificationRunning(run) {
  return ["running", "stopping"].includes(run?.validation?.process?.status);
}

function formatNormalizedBug(normalized) {
  const fields = normalized.fields || {};
  return [
    `缺陷编码：${fields.code || ""}`,
    `AID：${fields.aid || ""}`,
    `标题：${fields.title || ""}`,
    `状态：${fields.status || ""}`,
    `优先级 / 严重级别：${fields.priority || ""} / ${fields.severity || ""}`,
    `经办人：${fields.assignee || ""}`,
    `产品线 / 模块：${fields.product || ""} / ${fields.module || ""}`,
    `更新时间：${fields.updatedAt || ""}`,
    `环境：${fields.environment || ""}`,
    `客户端环境 client_env：`,
    ...formatClientEnv(fields.client_env),
    `关联版本：${fields.version || ""}`,
    `影响范围：${fields.impactScope || ""}`,
    `相关日志：${fields.logs || ""}`,
    `问题描述：${fields.description || ""}`,
    `复现步骤：`,
    ...(fields.reproduceSteps || []).map((step, index) => `  ${index + 1}. ${step}`),
    `期望结果：${fields.expected || ""}`,
    `实际结果：${fields.actual || ""}`,
    `验收标准：${fields.acceptanceCriteria || ""}`,
    `代码定位提示：${fields.repositoryHint || ""}`,
    `验证建议：${fields.testHint || ""}`,
    `附件：${fields.attachments?.length ? fields.attachments.join("、") : "无"}`
  ].join("\n");
}

function formatClientEnv(clientEnv = {}) {
  return [
    `  device_type：${clientEnv.device_type || ""}`,
    `  device_model：${clientEnv.device_model || ""}`,
    `  client_type：${clientEnv.client_type || ""}`,
    `  os：${clientEnv.os || ""}`,
    `  app_version：${clientEnv.app_version || ""}`,
    `  channel：${clientEnv.channel || ""}`,
    `  gateway_ip：${clientEnv.gateway_ip || ""}`,
    `  locale：${clientEnv.locale || ""}`
  ];
}

function calculateMetrics(bugs) {
  const metrics = {
    total: bugs.length,
    pending: 0,
    processing: 0,
    resolved: 0,
    other: 0
  };

  for (const bug of bugs) {
    metrics[statusGroupKey(bug.status)] += 1;
  }

  return metrics;
}

function statusGroupKey(status) {
  const value = String(status || "").toLowerCase();
  if (/待处理|未处理|待受理|待确认|待分配|open|new|todo|pending|onaudit/.test(value)) return "pending";
  if (/处理中|处理|进行中|修复中|in progress|doing|processing|develop|fix/.test(value)) return "processing";
  if (/已解决|已关闭|已完成|关闭|解决|完成|resolved|closed|done|finish/.test(value)) return "resolved";
  return "other";
}

async function api(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    Authorization: `Bearer ${sessionStorage.getItem("bugflow.sessionToken") || ""}`,
    ...(options.headers || {})
  };
  const response = await fetch(path, {
    ...options,
    headers
  });
  const data = await response.json();

  if (!response.ok) {
    if (response.status === 401) {
      sessionStorage.removeItem("bugflow.sessionToken");
      if (pollTimer) clearInterval(pollTimer);
      document.querySelector("#loginScreen").hidden = false;
      document.querySelector("#workspaceShell").hidden = true;
      document.querySelector("#loginError").textContent = data.message;
    }
    const error = new Error(data.message || "请求失败");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function currentView() {
  const view = location.hash.replace(/^#/, "");
  return ["workbench", "pipeline", "records", "history", "assignment", "config", "members", "account"].includes(view) ? view : "workbench";
}

function bindHistoryEvents() {
  document.querySelector('#historyFilters').addEventListener('submit', (event) => {
    event.preventDefault();
    historyState.agent = document.querySelector('#historyAgent').value;
    historyState.query = document.querySelector('#historyQuery').value.trim();
    historyState.workspace = document.querySelector('#historyWorkspace').value;
    loadAgentHistory(0);
  });
  for (const selector of ['#historyAgent', '#historyWorkspace']) document.querySelector(selector).addEventListener('change', () => document.querySelector('#historyFilters').requestSubmit());
  document.querySelector('#historyPrev').addEventListener('click', () => loadAgentHistory(Math.max(0, historyState.offset - 30)));
  document.querySelector('#historyNext').addEventListener('click', () => loadAgentHistory(historyState.offset + 30));
  document.querySelector('#historyList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-session-id]');
    if (button) loadAgentSession(button.dataset.sessionId);
  });
  document.querySelector('#historyDetail').addEventListener('click', (event) => {
    if (event.target.closest('[data-more-messages]') && historyState.detail) loadAgentSession(historyState.selected, historyState.detail.messages.length);
  });
}

const historyStatusLabel = (value) => ({ completed: '本轮结束', interrupted: '已中断', error: '发生错误', unknown: '运行状态未知' }[value] || '运行状态未知');
const historyTime = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '时间未知';

async function loadAgentHistory(offset = historyState.offset) {
  const request = ++historyState.listRequest;
  ++historyState.detailRequest;
  historyState.selected = null;
  historyState.detail = null;
  document.querySelector('#historyDetail').innerHTML = '<div class="history-empty"><span>◎</span><h2>从一个会话开始</h2><p>选择历史会话，查看对话与工作过程</p></div>';
  document.querySelector('#historyStatus').textContent = '正在读取历史会话，首次索引可能需要一些时间…';
  document.querySelector('#historyList').replaceChildren();
  document.querySelector('#historyPrev').disabled = true;
  document.querySelector('#historyNext').disabled = true;
  try {
    const query = new URLSearchParams({ offset, limit: 30, agent: historyState.agent, q: historyState.query, workspace: historyState.workspace });
    const data = await api(`/api/agent-sessions?${query}`);
    if (request !== historyState.listRequest) return;
    historyState.offset = data.offset; historyState.total = data.total;
    const sourceLabels = { available: '可读取', missing: '未找到历史目录', unconfigured: '未配置', error: '无法读取目录' };
    document.querySelector('#historySources').textContent = `${data.scope === 'all' ? '全部本地工作区' : '仅组织工作目录'} · ${data.providers.map((p) => `${p.label}：${sourceLabels[p.status]}${p.skipped ? `（${p.skipped} 项未能读取）` : ''}`).join(' · ')}`;
    document.querySelector('#historyAgent').innerHTML = '<option value="">全部 Agent</option>' + data.providers.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`).join('');
    document.querySelector('#historyAgent').value = historyState.agent;
    document.querySelector('#historyWorkspace').innerHTML = '<option value="">全部工作区</option>' + data.workspaces.map((w) => `<option value="${escapeHtml(w.path)}">${escapeHtml(w.path === '__unknown__' ? '未知工作区' : w.path)} (${w.count})</option>`).join('');
    if (historyState.workspace && !data.workspaces.some((w) => w.path === historyState.workspace)) {
      const option = document.createElement('option'); option.value = historyState.workspace; option.textContent = historyState.workspace + ' (0)'; document.querySelector('#historyWorkspace').append(option);
    }
    document.querySelector('#historyWorkspace').value = historyState.workspace;
    document.querySelector('#historyStatus').textContent = data.total ? `共 ${data.total} 个会话，按最近更新时间排序` : '没有匹配的会话，试试其他工作区或搜索词。';
    document.querySelector('#historyList').innerHTML = data.sessions.map((s) => `<button class="history-card" type="button" data-session-id="${escapeHtml(s.id)}" aria-pressed="false">
      <strong>${escapeHtml(s.title)}</strong>
      <span class="history-meta">${escapeHtml(s.agentLabel)} · ${historyTime(s.updatedAt)}</span>
      <span>${escapeHtml(historyStatusLabel(s.status))} · ${s.messageCount} 条记录${s.archived ? ' · 已归档' : ''}${s.partial ? ' · 部分记录' : ''}</span>
      <span class="history-meta">${escapeHtml(s.cwd?.split('/').filter(Boolean).at(-1) || '未知工作区')}${s.branch ? ' · ' + escapeHtml(s.branch) : ''}</span></button>`).join('');
    document.querySelector('#historyPage').textContent = data.total ? `${data.offset + 1}–${Math.min(data.offset + data.limit, data.total)} / ${data.total}` : '0 / 0';
    document.querySelector('#historyPrev').disabled = data.offset === 0;
    document.querySelector('#historyNext').disabled = data.offset + data.limit >= data.total;
  } catch (error) {
    if (request === historyState.listRequest) document.querySelector('#historyStatus').textContent = `加载失败：${error.message}`;
  }
}

async function loadAgentSession(id, offset = 0) {
  const request = ++historyState.detailRequest;
  historyState.selected = id;
  const panel = document.querySelector('#historyDetail');
  if (!offset) { historyState.detail = null; panel.textContent = '正在读取会话…'; }
  else { const button = panel.querySelector('[data-more-messages]'); if (button) button.disabled = true; }
  document.querySelectorAll('[data-session-id]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.sessionId === id)));
  try {
    const data = await api(`/api/agent-sessions/${encodeURIComponent(id)}?offset=${offset}&limit=100`);
    if (request !== historyState.detailRequest) return;
    historyState.detail = { ...data, messages: offset ? [...historyState.detail.messages, ...data.messages] : data.messages };
    const { session: s, messages, total } = historyState.detail;
    const duration = Math.max(0, Date.parse(s.updatedAt) - Date.parse(s.createdAt));
    const durationText = Number.isFinite(duration) ? `${Math.floor(duration / 60000)} 分钟 ${Math.floor(duration / 1000) % 60} 秒` : '未知';
    panel.innerHTML = `<header class="history-chat-header"><div><h2>${escapeHtml(s.title)}</h2><span>${escapeHtml(s.agentLabel)} · ${escapeHtml(s.cwd?.split('/').filter(Boolean).at(-1) || '未知工作区')}</span></div><span class="history-readonly">只读</span></header>
      <div class="history-chat-content"><details class="history-session-info"><summary>会话跨度 ${durationText}<span>›</span></summary>
      <dl class="history-info"><dt>会话 ID</dt><dd>${escapeHtml(s.sessionId || s.id)}</dd><dt>工作目录</dt><dd>${escapeHtml(s.workspaces?.join('、') || s.cwd || '未知')}</dd><dt>模型 / 分支</dt><dd>${escapeHtml(s.model || '未知')} / ${escapeHtml(s.branch || '未知')}</dd><dt>记录状态</dt><dd>${escapeHtml(historyStatusLabel(s.status))}</dd><dt>创建 / 更新</dt><dd>${historyTime(s.createdAt)} / ${historyTime(s.updatedAt)}</dd></dl></details>
      ${s.partial ? '<p class="history-warning">部分记录损坏、尚未写完或超出读取上限，当前展示部分内容。</p>' : ''}
      <div class="history-messages">${renderMessages(messages)}</div>
      <div class="history-chat-footer"><span>已显示 ${messages.length} / ${total} 条记录</span>${messages.length < total ? '<button class="button secondary" type="button" data-more-messages>加载更多记录</button>' : '<span>会话记录结束</span>'}</div></div>`;
  } catch (error) {
    if (request !== historyState.detailRequest) return;
    if (!offset) panel.textContent = `加载失败：${error.message}`;
    else { showToast(error.message); const button = panel.querySelector('[data-more-messages]'); if (button) button.disabled = false; }
  }
}

function setText(selector, value) {
  document.querySelector(selector).textContent = value;
}

function stateText(value) {
  return {
    ready: "待自动化",
    "pipeline-ready": "待预览",
    "manual-ready": "待人工执行",
    "manual-executed": "待验证",
    running: "执行中",
    reviewing: "Review中",
    "awaiting-review": "待人工Review",
    reviewed: "Review通过",
    validating: "验证中",
    stopping: "停止中",
    stopped: "已停止",
    interrupted: "已中断",
    validated: "验证通过",
    closed: "已关闭",
    "needs-review": "需复核"
  }[value] || value || "待自动化";
}

function runStatusText(value) {
  return {
    ready: "已生成待执行",
    "pipeline-ready": "已生成待执行",
    "manual-ready": "待人工执行",
    "manual-executed": "待验证",
    running: "执行中",
    reviewing: "Review中",
    "awaiting-review": "待人工 Review",
    reviewed: "Review 通过",
    validating: "验证中",
    stopping: "停止中",
    stopped: "已停止",
    interrupted: "已中断",
    validated: "验证通过",
    closed: "已关闭",
    "needs-review": "需要复核"
  }[value] || "等待执行";
}

function nodeStatusText(value) {
  return {
    pending: "等待中",
    ready: "可执行",
    running: "执行中",
    stopping: "停止中",
    stopped: "已停止",
    done: "完成",
    skipped: "已跳过",
    attention: "需复核",
    blocked: "阻塞"
  }[value] || value || "未知";
}

function tagClass(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDateText(value) {
  if (!value) return "无时间";
  return value;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}
