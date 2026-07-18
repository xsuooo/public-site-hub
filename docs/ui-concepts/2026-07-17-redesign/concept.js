(() => {
  const body = document.body;
  const params = new URLSearchParams(location.search);
  const page = body.dataset.page;

  const setTheme = (theme) => {
    body.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  };

  setTheme(params.get('theme') || 'light');
  body.dataset.capture = params.get('capture') === '1' ? 'true' : 'false';

  document.querySelectorAll('[data-concept-theme]').forEach((button) => {
    button.addEventListener('click', () => setTheme(button.dataset.conceptTheme));
  });

  let lastMenuTrigger = null;

  const closeMenus = (except = '', restoreFocus = false) => {
    document.querySelectorAll('[data-menu]').forEach((menu) => {
      if (menu.dataset.menu !== except) {
        menu.hidden = true;
        menu.style.removeProperty('top');
        menu.style.removeProperty('left');
      }
    });
    document.querySelectorAll('[data-menu-trigger]').forEach((trigger) => {
      if (trigger.dataset.menuTrigger !== except) trigger.setAttribute('aria-expanded', 'false');
    });
    if (restoreFocus && lastMenuTrigger instanceof HTMLElement) lastMenuTrigger.focus();
    if (!except) lastMenuTrigger = null;
  };

  const placeMenu = (trigger, menu) => {
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const edge = 8;
    const gap = 6;
    const left = Math.min(
      Math.max(edge, triggerRect.right - menuRect.width),
      window.innerWidth - menuRect.width - edge
    );
    const fitsBelow = triggerRect.bottom + gap + menuRect.height <= window.innerHeight - edge;
    const top = fitsBelow
      ? triggerRect.bottom + gap
      : Math.max(edge, triggerRect.top - menuRect.height - gap);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  };

  document.querySelectorAll('[data-menu-trigger]').forEach((trigger) => {
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const name = trigger.dataset.menuTrigger;
      const menu = document.querySelector(`[data-menu="${name}"]`);
      if (!menu) return;
      const willOpen = menu.hidden;
      if (!willOpen) {
        closeMenus('', true);
        return;
      }
      closeMenus(name);
      lastMenuTrigger = trigger;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      placeMenu(trigger, menu);
      menu.querySelector('.menu-item')?.focus();
    });
  });

  document.addEventListener('click', () => closeMenus());

  document.querySelectorAll('[data-menu]').forEach((menu) => {
    menu.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.target.closest('.menu-item')) window.setTimeout(() => closeMenus('', true));
    });
  });

  window.addEventListener('resize', () => closeMenus('', true));
  document.addEventListener('scroll', () => closeMenus('', true), true);

  document.querySelectorAll('[data-feedback]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
      button.textContent = button.dataset.feedback;
      button.disabled = true;
      window.setTimeout(() => {
        button.innerHTML = button.dataset.originalHtml;
        button.disabled = false;
      }, 1100);
    });
  });

  if (page === 'popup') {
    const list = document.querySelector('[data-site-list]');
    const cards = [...document.querySelectorAll('.site-card')];
    const empty = document.querySelector('[data-empty-state]');
    const emptyTitle = document.querySelector('[data-empty-title]');
    const emptyCopy = document.querySelector('[data-empty-copy]');
    const emptyAction = document.querySelector('[data-empty-action]');
    const progress = document.querySelector('[data-progress]');
    let state = params.get('state') === 'empty' ? 'empty' : 'mixed';
    let health = 'all';
    let category = 'all';
    let tag = '';
    let query = '';

    const renderPopup = () => {
      body.dataset.popupState = state;
      let visibleCount = 0;
      cards.forEach((card) => {
        const matches = state !== 'empty' &&
          (health === 'all' || card.dataset.health === health) &&
          (category === 'all' || card.dataset.category === category) &&
          (!tag || (card.dataset.tags || '').split(',').includes(tag)) &&
          (!query || (card.dataset.searchText || '').toLowerCase().includes(query));
        card.hidden = !matches;
        if (matches) visibleCount += 1;
      });
      const hasNoSites = state === 'empty';
      const hasNoMatches = !hasNoSites && visibleCount === 0;
      list.dataset.listState = hasNoSites ? 'empty' : hasNoMatches ? 'no-results' : 'results';
      empty.hidden = !hasNoSites && !hasNoMatches;
      if (emptyTitle) emptyTitle.textContent = hasNoSites ? '还没有站点' : '没有匹配结果';
      if (emptyCopy) {
        emptyCopy.textContent = hasNoSites
          ? '打开目标站后，点击上方「收藏当前页」；Key 可选，之后也能补充。'
          : '试试清除筛选，或换个关键词。';
      }
      if (emptyAction) emptyAction.hidden = !hasNoMatches;
      if (state === 'empty') progress.hidden = true;
      list.scrollTop = 0;
    };

    emptyAction?.addEventListener('click', () => {
      health = 'all';
      category = 'all';
      tag = '';
      query = '';
      document.querySelectorAll('[data-health-filter]').forEach((item) =>
        item.setAttribute('aria-pressed', String(item.dataset.healthFilter === 'all')));
      document.querySelectorAll('[data-category-filter]').forEach((item) =>
        item.setAttribute('aria-pressed', String(item.dataset.categoryFilter === 'all')));
      document.querySelectorAll('[data-tag-filter]').forEach((item) => item.setAttribute('aria-pressed', 'false'));
      const search = document.querySelector('[data-site-search]');
      if (search) search.value = '';
      const tagTrigger = document.querySelector('[data-menu-trigger="tags"]');
      if (tagTrigger) tagTrigger.childNodes[0].textContent = '标签 ';
      closeMenus();
      renderPopup();
    });

    document.querySelectorAll('[data-concept-state]').forEach((button) => {
      button.addEventListener('click', () => {
        state = button.dataset.conceptState;
        renderPopup();
      });
    });

    document.querySelectorAll('[data-health-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        health = button.dataset.healthFilter;
        document.querySelectorAll('[data-health-filter]').forEach((item) =>
          item.setAttribute('aria-pressed', String(item === button)));
        renderPopup();
      });
    });

    document.querySelectorAll('[data-category-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        category = button.dataset.categoryFilter;
        document.querySelectorAll('[data-category-filter]').forEach((item) =>
          item.setAttribute('aria-pressed', String(item === button)));
        renderPopup();
      });
    });

    document.querySelectorAll('[data-tag-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        tag = button.getAttribute('aria-pressed') === 'true' ? '' : button.dataset.tagFilter;
        document.querySelectorAll('[data-tag-filter]').forEach((item) =>
          item.setAttribute('aria-pressed', String(item.dataset.tagFilter === tag)));
        const trigger = document.querySelector('[data-menu-trigger="tags"]');
        if (trigger) trigger.childNodes[0].textContent = tag ? `标签 · ${tag} ` : '标签 ';
        closeMenus('', true);
        renderPopup();
      });
    });

    document.querySelector('[data-site-search]')?.addEventListener('input', (event) => {
      query = event.target.value.trim().toLowerCase();
      renderPopup();
    });

    const toggleProgress = () => {
      if (state === 'empty') return;
      progress.hidden = !progress.hidden;
    };
    document.querySelector('[data-progress-toggle]')?.addEventListener('click', toggleProgress);
    document.querySelector('[data-concept-progress]')?.addEventListener('click', toggleProgress);
    document.querySelector('[data-progress-stop]')?.addEventListener('click', (event) => {
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = '正在停止';
      progress.querySelector('[role="status"]').textContent = '正在停止余额刷新；当前站点完成后结束';
    });

    renderPopup();
  }

  if (page === 'options') {
    const optionsShell = document.querySelector('.options-shell');
    const conceptToolbar = document.querySelector('.concept-toolbar');
    const drawer = document.querySelector('[data-drawer]');
    const drawerScrim = document.querySelector('[data-drawer-scrim]');
    const dialog = document.querySelector('[data-dialog]');
    let lastDrawerTrigger = null;
    let lastDialogTrigger = null;
    let activeWorkspace = 'sites';
    let currentDialogType = '';

    const setPageInert = (inert) => {
      if (optionsShell) optionsShell.inert = inert;
      if (conceptToolbar) conceptToolbar.inert = inert;
      body.classList.toggle('modal-open', inert);
    };

    const writeRoute = (view = activeWorkspace, edit = '') => {
      const next = new URLSearchParams();
      next.set('view', view);
      if (edit) next.set('edit', edit);
      const hash = `#${next.toString()}`;
      if (location.hash !== hash) history.pushState(null, '', hash);
    };

    const switchWorkspace = (view, updateRoute = false) => {
      const target = ['sites', 'import', 'diagnostics'].includes(view) ? view : 'sites';
      document.querySelectorAll('[data-workspace]').forEach((workspace) => {
        workspace.hidden = workspace.dataset.workspace !== target;
      });
      document.querySelectorAll('.workspace-nav [data-workspace-switch]').forEach((button) => {
        if (button.dataset.workspaceSwitch === target) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      activeWorkspace = target;
      body.dataset.activeWorkspace = target;
      if (updateRoute) writeRoute(target);
    };

    document.querySelectorAll('[data-workspace-switch]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!drawer.hidden) closeDrawer(false, false);
        switchWorkspace(button.dataset.workspaceSwitch, true);
      });
    });

    const setDrawerMode = (requestedMode) => {
      const mode = ['add', 'batch', 'edit'].includes(requestedMode) ? requestedMode : 'edit';
      drawer.dataset.mode = mode;
      const title = document.querySelector('[data-drawer-title]');
      const subtitle = document.querySelector('[data-drawer-subtitle]');
      const form = document.querySelector('[data-drawer-form]');
      const nameInput = document.querySelector('#concept-site-name');
      const originInput = document.querySelector('#concept-site-origin');
      const baseInput = document.querySelector('#concept-site-base');
      const pageInput = document.querySelector('#concept-site-page');
      const tagsInput = document.querySelector('#concept-site-tags');
      const noteInput = document.querySelector('#concept-site-note');
      const typeSelect = document.querySelector('#concept-site-type');
      const nameLabel = document.querySelector('label[for="concept-site-name"]');
      const originLabel = document.querySelector('[data-origin-label]');

      document.querySelectorAll('[data-drawer-add-only]').forEach((item) => item.hidden = mode !== 'add');
      document.querySelectorAll('[data-drawer-batch-only]').forEach((item) => item.hidden = mode !== 'batch');
      document.querySelectorAll('[data-drawer-edit-only]').forEach((item) => item.hidden = mode !== 'edit');
      if (form) form.hidden = mode === 'batch';

      if (mode === 'add') {
        if (title) title.textContent = '添加站点';
        if (subtitle) subtitle.textContent = '先识别，再确认保存';
        if (nameLabel) nameLabel.textContent = '显示名称（可选）';
        if (originLabel) originLabel.textContent = '站点 URL 或域名';
        if (nameInput) nameInput.value = '';
        if (originInput) originInput.value = '';
        if (baseInput) baseInput.value = '';
        if (pageInput) pageInput.value = '';
        if (tagsInput) tagsInput.value = '';
        if (noteInput) noteInput.value = '';
        if (typeSelect) typeSelect.selectedIndex = 0;
      } else if (mode === 'batch') {
        if (title) title.textContent = '批量添加';
        if (subtitle) subtitle.textContent = '逐条识别并返回结果摘要';
      } else {
        if (title) title.textContent = '编辑站点';
        if (subtitle) subtitle.textContent = '星河公益站 · NewAPI';
        if (nameLabel) nameLabel.textContent = '名称';
        if (originLabel) originLabel.textContent = '站点 Origin';
        if (nameInput) nameInput.value = '星河公益站';
        if (originInput) originInput.value = 'https://api.starlight.invalid:8443';
        if (baseInput) baseInput.value = 'https://api.starlight.invalid:8443';
        if (pageInput) pageInput.value = 'https://api.starlight.invalid:8443/console';
        if (tagsInput) tagsInput.value = '常用, Claude';
        if (noteInput) noteInput.value = '稳定，适合日常调用。';
        if (typeSelect) typeSelect.selectedIndex = 1;
      }
      return mode;
    };

    const openDrawer = (requestedMode = 'edit', trigger = null, updateRoute = false) => {
      lastDrawerTrigger = trigger || document.activeElement;
      const mode = setDrawerMode(requestedMode);
      drawer.hidden = false;
      drawerScrim.hidden = false;
      setPageInert(true);
      drawer.querySelector('.drawer-body')?.scrollTo(0, 0);
      const focusTarget = mode === 'batch'
        ? drawer.querySelector('#concept-batch-sites')
        : drawer.querySelector(mode === 'add' ? '#concept-site-origin' : '#concept-site-name');
      focusTarget?.focus();
      if (updateRoute) writeRoute('sites', mode === 'edit' ? 'site-starlight' : '');
    };

    const closeDrawer = (restoreFocus = true, updateRoute = true) => {
      drawer.hidden = true;
      drawerScrim.hidden = true;
      setPageInert(false);
      if (updateRoute) writeRoute(activeWorkspace);
      if (restoreFocus && lastDrawerTrigger instanceof HTMLElement) lastDrawerTrigger.focus();
    };

    document.querySelectorAll('[data-drawer-open]').forEach((button) => {
      button.addEventListener('click', () => openDrawer(button.dataset.drawerOpen, button, true));
    });
    document.querySelectorAll('[data-drawer-toggle]').forEach((button) => {
      button.addEventListener('click', () => drawer.hidden ? openDrawer('edit', button) : closeDrawer());
    });
    document.querySelectorAll('[data-drawer-close]').forEach((button) => button.addEventListener('click', closeDrawer));
    drawerScrim?.addEventListener('click', closeDrawer);

    drawer?.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || dialog.open) return;
      const focusable = [...drawer.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden])')]
        .filter((item) => item.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    const dialogCopy = {
      replace: {
        title: '确认替换导入？',
        copy: '替换前会在本机创建一份含完整 Key 的恢复快照，最长保留 7 天。',
        action: '创建快照并替换',
        summary: [['当前', '12'], ['替换后', '8'], ['完整 Key', '5']]
      },
      export: {
        title: '导出完整 Key？',
        copy: '文件将包含 12 个站点和 9 个完整 Key。请只保存到可信位置，使用后立即清理。',
        action: '确认风险并导出',
        summary: [['站点', '12'], ['完整 Key', '9'], ['安全级别', '敏感']]
      },
      delete: {
        title: '删除所选站点？',
        copy: '将删除 2 个站点及其本机 Key。此操作不能通过普通撤销恢复。',
        action: '删除 2 个站点',
        summary: [['站点', '2'], ['完整 Key', '1'], ['结果', '不可撤销']]
      },
      'delete-site': {
        title: '删除星河公益站？',
        copy: '将同时删除该站点保存的 2 个完整 Key。此操作不可撤销。',
        action: '删除站点',
        summary: [['站点', '1'], ['完整 Key', '2'], ['结果', '不可撤销']]
      },
      restore: {
        title: '恢复这份快照？',
        copy: '恢复前会先为当前内容创建安全快照，然后用所选快照替换本机数据。',
        action: '创建安全快照并恢复',
        summary: [['快照站点', '12'], ['完整 Key', '9'], ['保留当前', '是']]
      },
      cleanup: {
        title: '清理全部恢复快照？',
        copy: '清理后将无法再从这些本机快照恢复站点和完整 Key。',
        action: '清理 3 份快照',
        summary: [['快照', '3'], ['完整 Key', '25'], ['结果', '不可撤销']]
      },
      'create-key': {
        title: '启用高风险 Key 策略？',
        copy: '之后自动创建的 Key 将使用无限额度且永不过期。只有明确理解风险时才启用。',
        action: '理解风险并启用',
        summary: [['额度', '无限'], ['有效期', '永不过期'], ['默认', '保持关闭']]
      }
    };

    const openDialog = (type = 'replace', trigger = null) => {
      lastDialogTrigger = trigger || document.activeElement;
      const content = dialogCopy[type] || dialogCopy.replace;
      currentDialogType = dialogCopy[type] ? type : 'replace';
      dialog.querySelector('h2').textContent = content.title;
      dialog.querySelector('[data-dialog-copy]').textContent = content.copy;
      dialog.querySelector('[data-dialog-confirm]').textContent = content.action;
      const labels = dialog.querySelectorAll('[data-dialog-label]');
      const values = dialog.querySelectorAll('[data-dialog-value]');
      content.summary.forEach(([label, value], index) => {
        if (labels[index]) labels[index].textContent = label;
        if (values[index]) values[index].textContent = value;
      });
      body.classList.add('modal-open');
      if (!dialog.open) dialog.showModal();
      dialog.querySelector('[data-dialog-close]')?.focus();
    };

    const closeDialog = () => {
      if (dialog.open) dialog.close();
    };

    document.querySelectorAll('[data-dialog-toggle]').forEach((button) => {
      button.addEventListener('click', () => openDialog(button.dataset.dialogToggle, button));
    });
    document.querySelectorAll('[data-dialog-close]').forEach((button) => button.addEventListener('click', closeDialog));
    document.querySelector('[data-dialog-confirm]')?.addEventListener('click', () => {
      if (currentDialogType === 'create-key' && lastDialogTrigger instanceof HTMLElement) {
        lastDialogTrigger.setAttribute('aria-checked', 'true');
      }
      closeDialog();
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog();
    });
    dialog.addEventListener('close', () => {
      body.classList.toggle('modal-open', !drawer.hidden);
      if (lastDialogTrigger instanceof HTMLElement) lastDialogTrigger.focus();
      currentDialogType = '';
    });

    let previewReady = params.get('preview') !== 'pending';
    const renderPreview = () => {
      document.querySelectorAll('[data-preview-result]').forEach((item) => item.hidden = !previewReady);
      document.querySelectorAll('[data-import-action]').forEach((button) => button.disabled = !previewReady);
      const status = document.querySelector('[data-preview-status]');
      const copy = document.querySelector('[data-preview-copy]');
      const toggle = document.querySelector('[data-preview-toggle]');
      if (status) {
        status.dataset.tone = previewReady ? 'success' : 'warning';
        status.textContent = previewReady ? '预览已完成' : '等待预览';
      }
      if (copy) copy.textContent = previewReady ? '已检查 8 条传入记录' : '执行预览后才能合并或替换';
      if (toggle) toggle.textContent = previewReady ? '重新预览' : '预览导入';
    };

    document.querySelectorAll('[data-import-source-button]').forEach((button) => {
      button.addEventListener('click', () => {
        const source = button.dataset.importSourceButton;
        document.querySelectorAll('[data-import-source-button]').forEach((item) =>
          item.setAttribute('aria-selected', String(item === button)));
        document.querySelectorAll('[data-import-source]').forEach((item) => item.hidden = item.dataset.importSource !== source);
        previewReady = false;
        renderPreview();
      });
    });
    document.querySelector('[data-preview-toggle]')?.addEventListener('click', () => {
      previewReady = !previewReady;
      renderPreview();
    });

    const readHashRoute = () => {
      const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
      return {
        view: hash.get('view') || (hash.has('edit') ? 'sites' : 'sites'),
        edit: hash.get('edit') || ''
      };
    };

    const applyRoute = (includeQuery = false) => {
      const route = readHashRoute();
      const view = includeQuery ? (params.get('view') || route.view) : route.view;
      switchWorkspace(view);
      const queryDrawer = includeQuery ? params.get('drawer') : '';
      const shouldEdit = route.edit || queryDrawer;
      if (shouldEdit) {
        const mode = queryDrawer && queryDrawer !== '1' ? queryDrawer : 'edit';
        openDrawer(mode, null, false);
      } else if (!drawer.hidden) {
        closeDrawer(false, false);
      }
    };

    renderPreview();
    applyRoute(true);
    if (params.get('dialog')) openDialog(params.get('dialog'));
    window.addEventListener('popstate', () => applyRoute(false));

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (dialog.open) closeDialog();
      else if (!drawer.hidden) closeDrawer();
      else closeMenus('', true);
    });
  } else {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenus('', true);
      }
    });
  }
})();
