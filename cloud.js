/* Shared auth and account-scoped cloud persistence for both languages. */
function createWodCloud(config) {
return {
  url: config.url,
  key: config.key,
  session: null,
  profile: null,
  syncTimeout: null,

  epoch: 0,
  cache: null,
  syncStatus: 'offline',
  refreshPromise: null,
  flushPromise: null,
  requestTimeout: 12000,

  emptyState() { return {version: 2, logs: [], profiles: {}, plans: [], customLifts: {}}; },
  cacheKey(id = this.user?.id) { return `${KEY}:user:${id}`; },
  message(ko, en) { return LANG === 'ko' ? ko : en; },
  report(error) {
    this.lastSyncError = error.message || String(error);
    this.setSyncStatus('offline');
    if ($('cloudStatusText')) $('cloudStatusText').textContent = this.lastSyncError;
    notify(this.lastSyncError);
  },
  readCache() {
    if (!this.user?.id) { this.cache = null; state = this.emptyState(); return; }
    const raw = localStorage.getItem(this.cacheKey());
    let cache = raw ? JSON.parse(raw) : null;
    // The legacy key belongs to the session that existed before this upgrade.
    if (!cache) {
      const previous = JSON.parse(localStorage.getItem(SB_SESSION_KEY) || 'null');
      const legacy = localStorage.getItem(KEY);
      if (previous?.user?.id === this.user.id && legacy) {
        const data = migrateState(JSON.parse(legacy));
        if (!validState(data)) throw new Error(t('corrupt'));
        cache = {data: normalizeState(data), dirty: true, revision: null, changeId: uid()};
      }
    }
    this.cache = cache || {data: this.emptyState(), dirty: false, revision: null, changeId: uid()};
    if (!validState(migrateState(this.cache.data))) throw new Error(t('corrupt'));
    state = normalizeState(migrateState(this.cache.data));
    this.cache.data = state;
    this.persistCache();
  },
  persistCache() {
    if (this.cache && this.user?.id) localStorage.setItem(this.cacheKey(), JSON.stringify(this.cache));
  },
  saveLocal(next, recover = false) {
    if (!this.user?.id || !this.isApproved) throw new Error(t('loginRequired'));
    // Do not silently replace another tab's unsent changes.
    const raw = localStorage.getItem(this.cacheKey());
    let other = null;
    try { other = raw ? JSON.parse(raw) : null; }
    catch (error) {
      if (!recover) throw error;
      localStorage.setItem(`${this.cacheKey()}:corrupt-backup:${Date.now()}`, raw);
    }
    if (other && this.cache && other.changeId !== this.cache.changeId) throw this.conflictError();
    // CSV/JSON restores must use the same approval workflow as the edit dialog.
    if (!this.isCoach) {
      const originals = new Map((this.cache?.data.logs || []).map(log => [log.id, log]));
      const fields = ['date','title','score','isRxd'];
      next = {...next, logs:next.logs.map(log => {
        const original = originals.get(log.id);
        if (!original || !fields.some(key => log[key] !== original[key])) return log;
        const pendingEdit = {...log.pendingEdit, requestedAt:new Date().toISOString()};
        const preserved = {...log};
        for (const key of fields) { pendingEdit[key] = log[key]; preserved[key] = original[key]; }
        return {...preserved, pendingEdit};
      })};
    }
    const cache = {...this.cache, data: next, dirty: true, changeId: uid()};
    localStorage.setItem(this.cacheKey(), JSON.stringify(cache));
    this.cache = cache;
    return next;
  },
  conflictError() {
    return new Error(this.message('다른 기기의 변경과 충돌했습니다. 현재 기록은 이 기기에 보관했습니다. 전체 백업 후 클라우드 기록을 불러와 변경 내용을 확인하세요.', 'Changes conflict with another device. Your local records are preserved. Export a full backup, then load the cloud records to compare.'));
  },
  init() {
    try {
      this.session = JSON.parse(localStorage.getItem(SB_SESSION_KEY) || 'null');
      if (!this.session?.user?.id || !this.session.access_token) this.session = null;
      const profile = JSON.parse(localStorage.getItem(SB_PROFILE_KEY) || 'null');
      this.profile = profile?.id === this.user?.id ? profile : null;
      this.readCache();
    } catch (e) {
      storageBlocked = true;
      this.cache = null;
      state = this.emptyState();
      warn('corrupt');
    }
    this.updateUI();
  },

  get token() {
    return this.session?.access_token || '';
  },

  get user() {
    return this.session?.user || null;
  },

  get isCoach() {
    return String(this.profile?.role || '').toLowerCase() === 'coach';
  },

  get isApproved() {
    return this.profile?.approved === true || this.isCoach;
  },

  setSyncStatus(status) {
    this.syncStatus = status;
    if (status === 'synced') this.lastSyncError = '';
    const dots = document.querySelectorAll('.sync-dot');
    dots.forEach(d => {
      d.classList.remove('synced', 'syncing', 'offline');
      d.classList.add(status);
    });
    const sideText = $('syncTextSide');
    if (sideText) {
      sideText.textContent = status === 'synced' ? t('syncOk') : status === 'syncing' ? t('syncing') : t('syncOffline');
    }
  },

  updateUI() {
    const isLoggedIn = !!this.session;
    const isCoach = this.isCoach;
    const isApproved = this.isApproved;


      if (!isLoggedIn || !isApproved) {
        document.body.classList.add('auth-locked');
      } else {
        document.body.classList.remove('auth-locked');
      }

    if ($('closeAuthBtn')) $('closeAuthBtn').hidden = !isLoggedIn;

    document.querySelectorAll('.coach-only').forEach(el => el.hidden = !isCoach);
    const bottomNav = document.querySelector('.bottom-nav');
    if (bottomNav) bottomNav.classList.toggle('has-coach', isCoach);

    if (!isCoach) {
      if ($('coachCompletionsDialog')?.open) $('coachCompletionsDialog').close();
      if (location.hash === '#coach' || ($('page-coach') && !$('page-coach').hidden)) {
        if (typeof showPage === 'function') showPage('todo');
      }
    }

    if ($('userBadgeSide')) $('userBadgeSide').hidden = !isLoggedIn;
    if ($('authPromptSide')) $('authPromptSide').hidden = isLoggedIn;
    if ($('userBadgeTop')) $('userBadgeTop').hidden = !isLoggedIn;
    if ($('loginBtnTop')) $('loginBtnTop').hidden = isLoggedIn;

    if (isLoggedIn) {
      const name = this.profile?.name || this.user?.email?.split('@')[0] || t('memberRole');
      const role = isCoach ? t('coachRole') : t('memberRole');
      if ($('userNameSide')) $('userNameSide').textContent = name;
      if ($('userRoleSide')) {
        $('userRoleSide').textContent = role;
        $('userRoleSide').className = `role-pill ${isCoach ? 'coach' : 'member'}`;
      }
      if ($('userNameTop')) $('userNameTop').textContent = name;
      if ($('userRoleTop')) {
        $('userRoleTop').textContent = role;
        $('userRoleTop').className = `role-pill ${isCoach ? 'coach' : 'member'}`;
      }
      this.setSyncStatus(this.syncStatus);

      const approvalDlg = $('approvalDialog');
      if (approvalDlg) {
        if (!isApproved) {
          if (!approvalDlg.open) approvalDlg.showModal();
        } else {
          if (approvalDlg.open) approvalDlg.close();
        }
      }
    } else {
      const approvalDlg = $('approvalDialog');
      if (approvalDlg && approvalDlg.open) approvalDlg.close();
      this.setSyncStatus('offline');
    }

    const cloudStatus = $('cloudStatusText');
    if (cloudStatus) {
      if (isLoggedIn) {
        cloudStatus.textContent = `${this.user?.email || ''} (${isCoach ? t('coachRole') : t('memberRole')}, ${isApproved ? t('approved') : t('pending')})`;
        if (this.lastSyncError) cloudStatus.textContent += ` · ${this.lastSyncError}`;
      } else {
        cloudStatus.textContent = t('loginRequired');
      }
    }
  },

  async rawRequest(endpoint, options = {}, token = '') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeout);
    try {
      const res = await fetch(`${this.url}${endpoint}`, {...options, signal: controller.signal,
        headers: {apikey: this.key, 'Content-Type': 'application/json',
          ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(options.headers || {})}});
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!res.ok) {
        const error = new Error(data?.msg || data?.message || data?.error_description || res.statusText);
        error.status = res.status; error.data = data;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(this.message('서버 응답 시간이 초과되었습니다. 기록은 이 기기에 보관됩니다.', 'The server timed out. Records are kept on this device.'));
      throw error;
    } finally { clearTimeout(timeout); }
  },
  async ensureToken(force = false) {
    if (!this.session) throw new Error(t('loginRequired'));
    if (!force && Number(this.session.expires_at) * 1000 > Date.now() + 60000) return;
    if (this.refreshPromise) return this.refreshPromise;
    const epoch = this.epoch;
    const refreshToken = this.session.refresh_token;
    const refresh = async () => {
      try {
        if (!refreshToken) { const error = new Error(t('loginRequired')); error.status = 401; throw error; }
        // Serialize refresh-token rotation between tabs where Web Locks is available.
        const stored = JSON.parse(localStorage.getItem(SB_SESSION_KEY) || 'null');
        if (!stored || stored.user?.id !== this.user?.id) throw new Error(t('loginRequired'));
        if (stored?.user?.id === this.user?.id && stored.refresh_token !== refreshToken) {
          this.session = stored;
          return;
        }
        const session = await this.rawRequest('/auth/v1/token?grant_type=refresh_token', {method: 'POST', body: JSON.stringify({refresh_token: refreshToken})});
        if (epoch !== this.epoch) throw new Error(t('loginRequired'));
        this.storeSession(session);
      } catch (error) {
        if (epoch === this.epoch && [400,401,403].includes(error.status)) this.clearSession();
        throw error;
      }
    };
    const promise = navigator.locks?.request ? navigator.locks.request('wodlog-auth-refresh', refresh) : refresh();
    this.refreshPromise = promise;
    try { await promise; } finally { if (this.refreshPromise === promise) this.refreshPromise = null; }
  },
  storeSession(session) {
    this.session = {...session, expires_at: session.expires_at || Math.floor(Date.now()/1000) + (session.expires_in || 0)};
    localStorage.setItem(SB_SESSION_KEY, JSON.stringify(this.session));
  },
  async req(endpoint, options = {}) {
    const epoch = this.epoch;
    await this.ensureToken();
    if (epoch !== this.epoch) throw new Error(t('loginRequired'));
    try {
      const data = await this.rawRequest(endpoint, options, this.token);
      if (epoch !== this.epoch) throw new Error(t('loginRequired'));
      return data;
    }
    catch (error) {
      if (error.status !== 401 || epoch !== this.epoch) throw error;
      await this.ensureToken(true);
      if (epoch !== this.epoch) throw new Error(t('loginRequired'));
      const data = await this.rawRequest(endpoint, options, this.token);
      if (epoch !== this.epoch) throw new Error(t('loginRequired'));
      return data;
    }
  },

  // Leaderboard & Program extensions for Requirements 0-6
  async signUp(email, password, name, gender = 'M') {
    const epoch = this.epoch;
    const res = await this.rawRequest('/auth/v1/signup', {method:'POST', body:JSON.stringify({email,password,data:{name:name||email.split('@')[0],gender}})});
    if (epoch !== this.epoch) throw new Error(t('loginRequired'));
    if (res.access_token) await this.acceptSession(res);
    return res;
  },

  async insertRows(table, payload) {
    this.droppedColumns = [];
    return this.req(`/rest/v1/${table}`, {method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(payload)});
  },

  async publishProgram(title, startDate, unit, programText, isPublic = true, category = 'WOD', items = null, wodSettings = null) {
    return await this.insertRows('coach_programs', {
      title,
      start_date: startDate,
      unit: unit || 'kg',
      program_text: programText,
      category: category || 'WOD',
      items: items && items.length ? items : null,
      wod_settings: category === 'WOD' ? wodSettings : null,
      is_public: isPublic,
      created_by: this.user?.id
    });
  },

  async batchPublishCoachPrograms(rows) {
    if (!rows || !rows.length) return [];
    return await this.insertRows('coach_programs', rows.map(p => ({
      title: p.title,
      start_date: p.start_date,
      unit: p.unit || 'kg',
      program_text: p.program_text,
      category: p.category || (p.title && p.title.includes('STRENGTH') ? 'STRENGTH' : 'WOD'),
      items: p.items && p.items.length ? p.items : null,
      wod_settings: p.category === 'STRENGTH' ? null : p.wod_settings || null,
      is_public: p.is_public !== false,
      created_by: this.user?.id
    })));
  },

  async toggleCoachProgramPublic(id, isPublic) {
    return await this.req(`/rest/v1/coach_programs?id=eq.${id}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ is_public: isPublic })
    });
  },

  async updateCoachProgram(id, patch) {
    const result = await this.req(`/rest/v1/coach_programs?id=eq.${id}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(patch)
    });
    if (!result?.length) {
      const error = new Error(this.message('공유 운동을 수정할 수 없습니다. 이미 삭제되었거나 DB 수정 권한(RLS UPDATE)이 필요합니다.', 'Could not update the shared workout. It may have been deleted or needs an UPDATE RLS policy.'));
      error.code = 'NOT_UPDATED';
      throw error;
    }
    return result;
  },

  async fetchSharedPrograms(date = null) {
    return this.req(date ? `/rest/v1/shared_programs?start_date=eq.${date}&select=*` : '/rest/v1/shared_programs?select=*&order=start_date.desc,created_at.desc');
  },

  async publishSharedProgram(title, startDate, unit, programText, category = 'WOD', items = null, wodSettings = null) {
    return await this.insertRows('shared_programs', {
      title,
      start_date: startDate,
      unit: unit || 'kg',
      program_text: programText,
      category: category || 'WOD',
      items: items && items.length ? items : null,
      wod_settings: category === 'WOD' ? wodSettings : null,
      user_id: this.user?.id,
      user_name: this.profile?.name || this.user?.email.split('@')[0],
      gender: this.profile?.gender || 'M',
      is_public: true
    });
  },

  async updateSharedProgram(id, patch) {
    const result = await this.req(`/rest/v1/shared_programs?id=eq.${id}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(patch)
    });
    if (!result?.length) {
      const error = new Error(this.message('공유 운동을 수정할 수 없습니다. 이미 삭제되었거나 DB 수정 권한(RLS UPDATE)이 필요합니다.', 'Could not update the shared workout. It may have been deleted or needs an UPDATE RLS policy.'));
      error.code = 'NOT_UPDATED';
      throw error;
    }
    return result;
  },

  async fetchPublishedProgram(table, id) {
    if (!['coach_programs', 'shared_programs'].includes(table) || !id) return null;
    const rows = await this.req(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=id`);
    return rows?.[0] || null;
  },

  async updatePublishedProgram(table, id, patch) {
    return table === 'coach_programs' ? this.updateCoachProgram(id, patch) : this.updateSharedProgram(id, patch);
  },

  async deletePublishedProgram(table, id) {
    return table === 'coach_programs' ? this.deleteCoachProgram(id) : this.deleteSharedProgram(id);
  },

  async batchPublishSharedPrograms(rows) {
    if (!rows || !rows.length) return [];
    return await this.insertRows('shared_programs', rows.map(p => ({
      title: p.title,
      start_date: p.start_date,
      unit: p.unit || 'kg',
      program_text: p.program_text,
      category: p.category || (p.title && p.title.includes('STRENGTH') ? 'STRENGTH' : 'WOD'),
      items: p.items && p.items.length ? p.items : null,
      wod_settings: p.category === 'STRENGTH' ? null : p.wod_settings || null,
      user_id: this.user?.id,
      user_name: this.profile?.name || this.user?.email.split('@')[0],
      gender: this.profile?.gender || 'M',
      is_public: p.is_public !== false
    })));
  },

  async deleteSharedProgram(id) {
    return await this.req(`/rest/v1/shared_programs?id=eq.${id}`, {
      method: 'DELETE'
    });
  },

  async fetchLeaderboard(title, date = null) {
    let url = `/rest/v1/box_leaderboard?title=eq.${encodeURIComponent(title)}&category=eq.WOD&status=eq.APPROVED&is_public=eq.true&select=*`;
    if (date) url += `&date=eq.${date}`;
    return this.req(url);
  },
  async fetch1RMLeaderboard(liftKey) {
    const title = `1RM · ${liftInfo(liftKey)?.en || liftKey}`;
    return this.req(`/rest/v1/box_leaderboard?title=eq.${encodeURIComponent(title)}&category=eq.1RM&status=eq.APPROVED&is_public=eq.true&select=*`);
  },
  async requestLogEdit(logId, updatedData, reason = '') {
    const logs = state.logs.map(log => log.id === logId ? {...log, pendingEdit:{...updatedData,reason,requestedAt:new Date().toISOString()}} : log);
    if (!commit({...state,logs})) throw new Error(t('saveFail'));
    await this.flush();
  },
  async fetchPendingEditRequests() {
    return this.req('/rest/v1/box_leaderboard?status=eq.PENDING_EDIT&select=*');
  },
  async approveLogEdit(requestId) { return this.reviewEdit(requestId, true); },
  async rejectLogEdit(requestId) { return this.reviewEdit(requestId, false); },
  async reviewEdit(requestId, approved) {
    return this.req('/rest/v1/rpc/review_wod_edit', {method:'POST',body:JSON.stringify({p_id:requestId,p_approve:approved})});
  },

  async acceptSession(session) {
    this.epoch++;
    this.profile = null;
    this.session = session;
    storageBlocked = false;
    try { this.readCache(); }
    catch (error) { storageBlocked = true; state = this.emptyState(); warn('corrupt'); throw error; }
    this.storeSession(session);
    localStorage.removeItem(SB_PROFILE_KEY);
    try {
      await this.fetchProfile();
      if (this.isApproved) await this.syncPullOrPush();
    } catch (error) {
      this.report(error);
      if (!this.profile) throw error;
    }
    this.updateUI();
  },
  async signIn(email, password) {
    const epoch = this.epoch;
    const res = await this.rawRequest('/auth/v1/token?grant_type=password', {method:'POST',body:JSON.stringify({email,password})});
    if (epoch !== this.epoch) throw new Error(t('loginRequired'));
    await this.acceptSession(res);
    return res;
  },
  clearSession() {
    this.epoch++;
    clearTimeout(this.syncTimeout);
    this.syncTimeout = null;
    this.refreshPromise = null;
    this.flushPromise = null;
    this.session = null; this.profile = null; this.cache = null;
    this.lastSyncError = '';
    try { localStorage.removeItem(SB_SESSION_KEY); localStorage.removeItem(SB_PROFILE_KEY); }
    catch (error) { console.warn('Could not clear persisted session', error); }
    state = this.emptyState();
    coachPrograms = []; sharedPrograms = []; cachedMembers = []; cachedCoachPrograms = [];
    for (const id of ['membersList','coachProgramsList','coachEditRequestsList']) if ($(id)) $(id).innerHTML = '';
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    this.updateUI();
    refresh();
    resetEntry('log');
    openAuthModal();
  },
  async signOut() {
    const token = this.token;
    // Account-scoped pending records stay on disk; logout never waits for the network.
    this.clearSession();
    if (token) void this.rawRequest('/auth/v1/logout?scope=local', {method:'POST'}, token).catch(error => console.warn('Remote sign-out unavailable', error));
  },
  async fetchProfile() {
    if (!this.user?.id) return null;
    const epoch = this.epoch;
    const list = await this.req(`/rest/v1/profiles?id=eq.${this.user.id}&select=*`);
    if (epoch !== this.epoch) return null;
    if (!list?.length) {
      this.clearSession();
      throw new Error(this.message('회원 프로필을 찾을 수 없습니다. 코치에게 문의하세요.', 'Member profile not found. Contact your coach.'));
    }
    this.profile = list[0];
    localStorage.setItem(SB_PROFILE_KEY,JSON.stringify(this.profile));
    this.updateUI();
    return this.profile;
  },
  scheduleSync() {
    if (!this.session || !this.isApproved || !this.cache?.dirty) return;
    this.setSyncStatus('syncing');
    clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => this.flush().catch(error => this.report(error)), 1500);
  },
  async flush() {
    if (this.flushPromise) return this.flushPromise;
    const epoch = this.epoch;
    const run = async () => {
      if (!this.session || !this.isApproved) throw new Error(t('loginRequired'));
      if (this.cache?.revision == null) await this.syncPullOrPush(false);
      while (epoch === this.epoch && this.cache?.dirty) {
        const snapshot = JSON.parse(JSON.stringify(this.cache));
        // Persist mutation identity so a retry after a lost response is idempotent.
        for (const [key,p] of Object.entries(snapshot.data.profiles)) p.liftName = liftInfo(key)?.en || key;
        this.setSyncStatus('syncing');
        let result;
        try {
          result = await this.req('/rest/v1/rpc/save_wod_data', {method:'POST',body:JSON.stringify({p_data:snapshot.data,p_expected_revision:snapshot.revision,p_mutation_id:snapshot.changeId})});
        } catch (error) {
          if (error.data?.code === '40001') throw this.conflictError();
          throw error;
        }
        if (epoch !== this.epoch) return;
        if (!result || !validState(result.data)) throw new Error(t('corrupt'));
        // A storage event may have delivered an edit from another tab while saving.
        const stored = JSON.parse(localStorage.getItem(this.cacheKey()) || 'null');
        if (stored && stored.changeId !== this.cache.changeId) this.cache = stored;
        this.cache.revision = result.revision;
        if (this.cache.changeId === snapshot.changeId) {
          this.cache.data = normalizeState(result.data); this.cache.dirty = false;
          state = this.cache.data;
        }
        this.persistCache();
        refresh();
      }
      if (epoch === this.epoch) this.setSyncStatus('synced');
    };
    // A per-account Web Lock prevents two tabs from sending different snapshots
    // against the same revision. PostgreSQL still checks revisions across devices.
    const promise = navigator.locks?.request
      ? navigator.locks.request(`wodlog-sync:${this.user?.id}`, run) : run();
    this.flushPromise = promise;
    try { await promise; }
    finally { if (this.flushPromise === promise) this.flushPromise = null; }
  },
  async syncPullOrPush(push = true) {
    if (!this.session || !this.isApproved) return;
    if (storageBlocked || !this.cache) throw new Error(t('corrupt'));
    const epoch = this.epoch;
    const initialChangeId = this.cache?.changeId;
    const initialRevision = this.cache?.revision;
    this.setSyncStatus('syncing');
    const list = await this.req(`/rest/v1/member_data?user_id=eq.${this.user.id}&select=*`);
    if (epoch !== this.epoch) return;
    // A late read must not roll back a completed save or another tab's new state.
    if (this.cache?.revision !== initialRevision || this.cache?.changeId !== initialChangeId) {
      if (push && this.cache?.dirty) await this.flush();
      return;
    }
    const row = list?.[0];
    if (row && !validState(migrateState(row.data))) throw new Error(t('corrupt'));
    if (row && row.revision === undefined) throw new Error(this.message('서버 업데이트가 필요합니다. supabase/repair.sql을 적용해주세요. 로컬 기록은 보관됩니다.', 'Apply supabase/repair.sql before cloud sync. Local records are preserved.'));
    if (this.cache.dirty) {
      if (this.cache.revision == null) {
        if (row && JSON.stringify(normalizeState(row.data)) !== JSON.stringify(state)) throw this.conflictError();
        this.cache.revision = row?.revision ?? 0;
        this.persistCache();
      }
      if (push) await this.flush();
      return;
    }
    state = row ? normalizeState(migrateState(row.data)) : this.emptyState();
    this.cache = {data:state,dirty:false,revision:row?.revision??0,changeId:uid()};
    this.persistCache();
    refresh(); loadRM(); this.setSyncStatus('synced');
  },
  async restoreCloud() {
    if (!this.session || !this.isApproved) throw new Error(t('loginRequired'));
    // A failed pending upload is exactly when the recovery action is needed.
    if (this.flushPromise) await this.flushPromise.catch(() => {});
    clearTimeout(this.syncTimeout);
    const epoch = this.epoch;
    const changeId = this.cache?.changeId;
    const list = await this.req(`/rest/v1/member_data?user_id=eq.${this.user.id}&select=*`);
    if (epoch !== this.epoch) return;
    if (changeId !== this.cache?.changeId) throw this.conflictError();
    const row = list?.[0];
    if (!row || row.revision === undefined || !validState(migrateState(row.data))) throw new Error(this.message('불러올 클라우드 기록이 없거나 서버 업데이트가 필요합니다.', 'No cloud record is available, or the server needs updating.'));
    // Keep a recovery copy even after the user explicitly chooses the cloud version.
    localStorage.setItem(`${this.cacheKey()}:before-restore:${Date.now()}`, localStorage.getItem(this.cacheKey()) || JSON.stringify(this.cache));
    state = normalizeState(migrateState(row.data));
    this.cache = {data:state,dirty:false,revision:row.revision,changeId:uid()};
    storageBlocked = false;
    if ($('storageWarning')) $('storageWarning').hidden = true;
    this.persistCache(); refresh(); loadRM(); this.setSyncStatus('synced');
  },

  async fetchMembers() {
    return await this.req('/rest/v1/profiles?select=*&order=created_at.desc');
  },

  async updateMember(userId, patch) {
    const result = await this.req(`/rest/v1/profiles?id=eq.${userId}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify(patch)
    });
    if (!result?.length) throw new Error(this.message('회원 정보를 변경하지 못했습니다.', 'Could not update the member.'));
    return result;
  },

  async demoteCoach(userId) { return this.changeRole(userId, 'member'); },
  async makeCoach(userId) { return this.changeRole(userId, 'coach'); },
  async changeRole(userId, role) {
    const ok = await this.req('/rest/v1/rpc/change_member_role', {method:'POST',body:JSON.stringify({target_user_id:userId,new_role:role})});
    if (ok !== true) throw new Error(this.message('회원 역할을 변경하지 못했습니다.', 'Could not change the member role.'));
    return true;
  },
  async deleteMember(userId) {
    const ok = await this.req('/rest/v1/rpc/delete_member', {method:'POST',body:JSON.stringify({target_user_id:userId})});
    if (ok !== true) throw new Error(this.message('회원을 삭제하지 못했습니다.', 'Could not delete the member.'));
    return true;
  },

  async fetchCoachPrograms() {
    return await this.req('/rest/v1/coach_programs?select=*&order=start_date.desc,created_at.desc');
  },

  async fetchCoachCompletions(programId) {
    if (!this.isCoach) throw new Error(this.message('코치만 수행 여부를 확인할 수 있습니다.', 'Only coaches can view participation.'));
    return this.req('/rest/v1/rpc/get_coach_program_completions', {
      method: 'POST', body: JSON.stringify({p_program_id: programId})
    });
  },

  async deleteCoachPrograms(ids) {
    const list = (ids || []).filter(id => /^[0-9a-fA-F-]{36}$/.test(id));
    if (!list.length) return null;
    return await this.req(`/rest/v1/coach_programs?id=in.(${list.join(',')})`, { method: 'DELETE' });
  },

  async deleteCoachProgram(id) {
    return await this.req(`/rest/v1/coach_programs?id=eq.${id}`, {
      method: 'DELETE'
    });
  }
};

}

/* WOD prescriptions are separate from an athlete's result. Legacy text is read
 * conservatively; unknown settings remain missing and are flagged in the UI. */
const WodFormat = {
  types: ['FOR_TIME','AMRAP','EMOM','INTERVAL_TABATA','FOR_QUALITY'],
  integer(n,min,max) { return Number.isInteger(n)&&n>=min&&n<=max; },
  clean(value) {
    if (!value || !this.types.includes(value.workoutType)) return null;
    const out={workoutType:value.workoutType};
    if(out.workoutType==='FOR_TIME'&&this.integer(value.timeCapMinutes,1,1440))out.timeCapMinutes=value.timeCapMinutes;
    if(out.workoutType==='AMRAP'&&this.integer(value.durationMinutes,1,1440))out.durationMinutes=value.durationMinutes;
    if(['EMOM','INTERVAL_TABATA'].includes(out.workoutType)){
      const s=value.intervalSettings||{},v={};
      if(this.integer(s.workSeconds,1,86400))v.workSeconds=s.workSeconds;
      if(this.integer(s.restSeconds,0,86400))v.restSeconds=s.restSeconds;
      if(this.integer(s.rounds,1,10000))v.rounds=s.rounds;
      if(['REPS','TIME','CUSTOM'].includes(s.scoreType))v.scoreType=s.scoreType;
      out.intervalSettings=v;
    }
    return out;
  },
  valid(value) {
    const p=this.clean(value);if(!p)return false;
    if(p.workoutType==='FOR_TIME')return value.timeCapMinutes==null||this.integer(value.timeCapMinutes,1,1440);
    if(p.workoutType==='AMRAP')return this.integer(p.durationMinutes,1,1440);
    if(['EMOM','INTERVAL_TABATA'].includes(p.workoutType)){
      const s=p.intervalSettings;
      return this.integer(s.workSeconds,1,86400)&&this.integer(s.restSeconds,0,86400)&&this.integer(s.rounds,1,10000)&&
        (p.workoutType==='EMOM'?s.workSeconds%60===0&&s.restSeconds===0&&s.scoreType==='CUSTOM':['REPS','TIME'].includes(s.scoreType));
    }
    return true;
  },
  infer(text) {
    const s=String(text||'').normalize('NFKC');
    const found=[];
    if(/\bfor\s+time\b/i.test(s))found.push('FOR_TIME');
    if(/\bamrap\b/i.test(s))found.push('AMRAP');
    if(/\b(?:emom|eomom|e\d+mom)\b|\bevery\s+(?:\d+(?::00|\s*(?:min(?:utes?)?|분))|minute)/i.test(s))found.push('EMOM');
    if(/\b(?:tabata|interval)\b|타바타|인터벌/i.test(s))found.push('INTERVAL_TABATA');
    if(/\bfor\s+quality\b/i.test(s))found.push('FOR_QUALITY');
    if(found.length!==1)return {settings:null,ambiguous:found.length>1};
    const p={workoutType:found[0]};let m;
    if(p.workoutType==='FOR_TIME'){
      m=s.match(/(?:time\s*cap|\bt\.?c\.?\b|타임\s*캡)\s*[:=\-]?\s*(\d+(?:\.\d+)?)(?::(\d{2}))?/i);
      if(m)p.timeCapMinutes=Number(m[1])+(m[2]?Number(m[2])<60?Number(m[2])/60:NaN:0);
    }
    if(p.workoutType==='AMRAP'){
      m=s.match(/\bamrap\s*[:\-]?\s*(\d+(?:\.\d+)?)(?::(\d{2}))?/i)||s.match(/(\d+(?:\.\d+)?)\s*(?:min(?:utes?)?\.?|분|['′])\s*amrap\b/i);
      if(m)p.durationMinutes=Number(m[1])+(m[2]?Number(m[2])<60?Number(m[2])/60:NaN:0);
    }
    if(p.workoutType==='EMOM'){
      const every=s.match(/\be(\d+)mom\b/i)||s.match(/\bevery\s+(\d+)(?::00|\s*(?:min(?:utes?)?|분))/i);
      const minutes=every?Number(every[1]):/\beomom\b/i.test(s)?2:1;
      const rounds=s.match(/(\d+)\s*(?:rounds?\b|라운드)/i)||s.match(/(?:rounds?\b|라운드)\s*[:=]\s*(\d+)/i);
      const duration=s.match(/\bfor\s+(\d+)(?::00|\s*(?:min(?:utes?)?|분|['′]))/i)||s.match(/\b(?:emom|eomom|e\d+mom)\s*[:\-]?\s*(\d+)(?::00)?/i)||s.match(/(\d+)\s*(?:min(?:utes?)?\.?|분|['′])\s*(?:emom|eomom|e\d+mom)\b/i);
      p.intervalSettings={workSeconds:minutes*60,restSeconds:0,scoreType:'CUSTOM'};
      if(rounds)p.intervalSettings.rounds=Number(rounds[1]);
      else if(duration&&Number(duration[1])%minutes===0)p.intervalSettings.rounds=Number(duration[1])/minutes;
    }
    if(p.workoutType==='INTERVAL_TABATA'){
      const tabata=/\btabata\b|타바타/i.test(s);
      const pair=s.match(/(?:tabata|interval|타바타|인터벌)\s*[:\-]?\s*(\d+)\s*\/\s*(\d+)/i)||s.match(/(\d+)\s*(?:s(?:ec(?:onds?)?)?|초)\s*(?:on)?\s*\/\s*(\d+)\s*(?:s(?:ec(?:onds?)?)?|초)/i);
      const work=s.match(/(?:\bwork\b|\bon\b|운동)\s*[:=]?\s*(\d+)\s*(?:s(?:ec(?:onds?)?)?\b|초)/i);
      const rest=s.match(/(?:\brest\b|\boff\b|휴식)\s*[:=]?\s*(\d+)\s*(?:s(?:ec(?:onds?)?)?\b|초)/i);
      const rounds=s.match(/(\d+)\s*(?:rounds?\b|라운드)/i)||s.match(/(?:rounds?\b|라운드)\s*[:=]\s*(\d+)/i)||s.match(/[x×]\s*(\d+)\b/i);
      p.intervalSettings={scoreType:/score\s*[:=]\s*time|결과\s*[:=]\s*시간/i.test(s)?'TIME':'REPS'};
      if(work||pair||tabata)p.intervalSettings.workSeconds=work?Number(work[1]):pair?Number(pair[1]):20;
      if(rest||pair||tabata)p.intervalSettings.restSeconds=rest?Number(rest[1]):pair?Number(pair[2]):10;
      if(rounds||tabata)p.intervalSettings.rounds=rounds?Number(rounds[1]):8;
    }
    return {settings:this.clean(p),ambiguous:false,complete:this.valid(p)};
  },
  resolve(program) {
    if(program.wod_settings!=null){
      const settings=this.clean(program.wod_settings);
      return {settings,complete:this.valid(program.wod_settings),source:'saved'};
    }
    return {...this.infer(`${program.program_text||''}\n${program.title||''}`),source:'text'};
  },
  fromPlan(plan) {
    return this.clean({workoutType:plan.workoutType,timeCapMinutes:plan.timeCapMinutes,durationMinutes:plan.durationMinutes,intervalSettings:plan.intervalSettings});
  },
  fromProgramPlan(plan) {
    const inferred=this.infer(plan.content);
    if(inferred.ambiguous || (inferred.settings&&!inferred.complete))return null;
    return inferred.settings||this.fromPlan(plan);
  }
};

function applyPublishedWod(settings){
 const p=WodFormat.clean(settings);if(!p)return false;
 $('workoutType').value=p.workoutType;scoreFields();
 if(p.workoutType==='FOR_TIME'&&p.timeCapMinutes){$('plannedCap').value=p.timeCapMinutes;$('capMinutes').value=p.timeCapMinutes;}
 if(p.workoutType==='AMRAP'&&p.durationMinutes)$('amrapMinutes').value=p.durationMinutes;
 if(p.workoutType==='EMOM'){
  const s=p.intervalSettings,minutes=s.workSeconds/60;
  if(Number.isInteger(minutes)&&minutes>0){$('emomEvery').value=[1,2,3].includes(minutes)?String(minutes):'custom';$('emomCustom').value=minutes;$('customEveryWrap').hidden=$('emomEvery').value!=='custom';}
  if(s.rounds)$('emomRounds').value=s.rounds;
 }
 if(p.workoutType==='INTERVAL_TABATA'){
  const s=p.intervalSettings;
  for(const [key,id] of [['workSeconds','workSeconds'],['restSeconds','restSeconds'],['rounds','intervalRounds']])if(s[key]!=null)$(id).value=s[key];
  if(['REPS','TIME'].includes(s.scoreType)){$('intervalScoreType').value=s.scoreType;intervalScoreFields();}
 }
 updateTimerIdle();return true;
}
function wodFormatSummary(p){
 const s=p.intervalSettings;
 return [TYPES[p.workoutType],p.timeCapMinutes?`${t('capWord')} ${p.timeCapMinutes} ${t('minutes')}`:'',p.durationMinutes?`${p.durationMinutes} ${t('minutes')}`:'',s?(p.workoutType==='EMOM'?`${s.workSeconds/60} ${t('minutes')} × ${s.rounds} ${t('roundWord')}`:`${s.workSeconds}/${s.restSeconds} ${t('seconds')} × ${s.rounds} ${t('roundWord')} · ${t(s.scoreType==='TIME'?'timeMode':'repsMode')}`):''].filter(Boolean).join(' · ');
}
