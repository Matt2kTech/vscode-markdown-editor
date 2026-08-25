import { callCommand, insert } from '@milkdown/utils';
import {
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  createCodeBlockCommand,
  toggleStrongCommand,
  toggleEmphasisCommand,
  wrapInBlockquoteCommand,
} from '@milkdown/preset-commonmark';
import { addRowAfterCommand, addColAfterCommand, toggleStrikethroughCommand } from '@milkdown/preset-gfm';
import { deleteRow, deleteColumn, deleteTable } from '@milkdown/prose/tables';
import { editorViewCtx } from '@milkdown/core';
import { state, vscode } from '../state';
import { initCodeMirror } from '../editor/codemirror';
import { updateMetadataUI } from './metadata';
import { searchPluginKey } from '../plugins/search';

let targetImage: HTMLImageElement | null = null;

export function setupUIEvents() {
  // Intercept programmatic window.open calls (e.g. from Milkdown tooltip plugins)
  const originalOpen = window.open;
  window.open = function(url?: string | URL, target?: string, features?: string): Window | null {
    if (url) {
      const urlStr = url.toString();
      if (vscode) {
        vscode.postMessage({ type: 'openLink', value: urlStr, resolvedValue: urlStr });
      }
      return null;
    }
    return originalOpen.apply(window, [url, target, features]);
  };

  setupImageObserver();
  setupToolbarEvents();
  setupContextMenuEvents();
  setupTableModalEvents();
  setupFindWidgetEvents();
  setupOtherEvents();
  setupBookmarkTooltip();
}

function setupImageObserver() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) {
            const imgs =
              node.tagName === 'IMG'
                ? [node as HTMLImageElement]
                : Array.from(node.querySelectorAll('img'));
            imgs.forEach((img) => {
              const originalSrc = img.getAttribute('src');
              if (originalSrc && originalSrc.startsWith('/')) {
                if (originalSrc.startsWith('vscode-webview:')) return;
                const prefix = state.publicPathPrefix
                  ? state.publicPathPrefix.startsWith('/')
                    ? state.publicPathPrefix
                    : '/' + state.publicPathPrefix
                  : '';
                img.setAttribute('data-raw-src', originalSrc);
                if (state.workspaceRoot) {
                  const root = state.workspaceRoot.endsWith('/') ? state.workspaceRoot.slice(0, -1) : state.workspaceRoot;
                  const path = (prefix + originalSrc).replace(/\/\//g, '/');
                  img.src = root + path;
                } else {
                  img.src = (prefix + originalSrc).replace(/\/\//g, '/');
                }
              } else if (originalSrc && !img.hasAttribute('data-raw-src')) {
                img.setAttribute('data-raw-src', originalSrc);
              }
            });
          }
        });
      } else if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
        const img = mutation.target as HTMLImageElement;
        const originalSrc = img.getAttribute('src');
        if (originalSrc && originalSrc.startsWith('/')) {
          if (originalSrc.startsWith('vscode-webview:') || originalSrc.startsWith('https://file+.vscode-resource')) return;
          const prefix = state.publicPathPrefix
            ? state.publicPathPrefix.startsWith('/')
              ? state.publicPathPrefix
              : '/' + state.publicPathPrefix
            : '';
          if (
            !img.hasAttribute('data-raw-src') ||
            img.getAttribute('data-raw-src') !== originalSrc
          ) {
            img.setAttribute('data-raw-src', originalSrc);
            if (state.workspaceRoot) {
              const root = state.workspaceRoot.endsWith('/') ? state.workspaceRoot.slice(0, -1) : state.workspaceRoot;
              const path = (prefix + originalSrc).replace(/\/\//g, '/');
              img.src = root + path;
            } else {
              img.src = (prefix + originalSrc).replace(/\/\//g, '/');
            }
          }
        }
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  });

  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'IMG') {
      e.preventDefault();
      targetImage = target as HTMLImageElement;
      const imageMenu = document.getElementById('image-context-menu');
      if (imageMenu) {
        imageMenu.style.display = 'block';
        imageMenu.style.left = `${e.pageX}px`;
        imageMenu.style.top = `${e.pageY}px`;
      }
    }
  });

  const linkInterceptor = (e: Event) => {
    const path = e.composedPath();
    const link = path.find((node) => node instanceof HTMLElement && node.tagName === 'A') as HTMLAnchorElement;
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'click' && vscode) {
        const hrefAttr = link.getAttribute('href');
        const hrefProp = link.href;
        vscode.postMessage({ type: 'openLink', value: hrefAttr, resolvedValue: hrefProp });
      }
    }
  };

  document.addEventListener('click', linkInterceptor, true);
  document.addEventListener('mousedown', linkInterceptor, true);
  document.addEventListener('auxclick', linkInterceptor, true);
}

function setupToolbarEvents() {
  document.getElementById('btn-bold')?.addEventListener('click', () => {
    if (state.editor) state.editor.action(callCommand(toggleStrongCommand.key));
  });
  document.getElementById('btn-italic')?.addEventListener('click', () => {
    if (state.editor) state.editor.action(callCommand(toggleEmphasisCommand.key));
  });
  document.getElementById('btn-strike')?.addEventListener('click', () => {
    if (state.editor) state.editor.action(callCommand(toggleStrikethroughCommand.key));
  });
  document.getElementById('btn-quote')?.addEventListener('click', () => {
    if (state.editor) state.editor.action(callCommand(wrapInBlockquoteCommand.key));
  });
  document.getElementById('btn-footnote')?.addEventListener('click', () => {
    if (state.editor) {
      import('../utils/markdown').then(({ insertFootnote }) => {
        state.editor.action((ctx) => insertFootnote(ctx));
      });
    }
  });

  document.getElementById('btn-code')?.addEventListener('click', () => {
    if (state.editor) state.editor.action(callCommand(createCodeBlockCommand.key));
  });
  document.getElementById('btn-bullet')?.addEventListener('click', () => {
    if (state.editor) {
      state.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state: pmState, dispatch } = view;
        const { $from, $to } = pmState.selection;
        const range = $from.blockRange($to);
        
        let listNodePos = -1;
        let listNode = null;
        if (range) {
          for (let d = range.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') {
              listNodePos = $from.before(d);
              listNode = node;
              break;
            }
          }
        }
        
        if (listNode && listNode.type.name === 'ordered_list') {
          dispatch(pmState.tr.setNodeMarkup(listNodePos, pmState.schema.nodes.bullet_list));
        } else {
          callCommand(wrapInBulletListCommand.key)(ctx);
        }
      });
    }
  });

  document.getElementById('btn-ordered')?.addEventListener('click', () => {
    if (state.editor) {
      state.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state: pmState, dispatch } = view;
        const { $from, $to } = pmState.selection;
        const range = $from.blockRange($to);
        
        let listNodePos = -1;
        let listNode = null;
        if (range) {
          for (let d = range.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') {
              listNodePos = $from.before(d);
              listNode = node;
              break;
            }
          }
        }
        
        if (listNode && listNode.type.name === 'bullet_list') {
          dispatch(pmState.tr.setNodeMarkup(listNodePos, pmState.schema.nodes.ordered_list));
        } else {
          callCommand(wrapInOrderedListCommand.key)(ctx);
        }
      });
    }
  });

  document.getElementById('btn-task')?.addEventListener('click', () => {
    if (state.editor) {
      state.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state: pmState, dispatch } = view;
        const { $from, $to } = pmState.selection;
        const range = $from.blockRange($to);
        
        let listNodePos = -1;
        let listNode = null;
        if (range) {
          for (let d = range.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name === 'list_item') {
              listNodePos = $from.before(d);
              listNode = node;
              break;
            }
          }
        }
        
        if (listNode) {
          const checked = listNode.attrs.checked;
          const newChecked = checked == null ? false : (checked === false ? true : null);
          dispatch(pmState.tr.setNodeMarkup(listNodePos, undefined, { ...listNode.attrs, checked: newChecked }));
        } else {
          insert('\n- [ ] Task')(ctx);
        }
      });
    }
  });

  document.getElementById('btn-link')?.addEventListener('click', () => {
    if (vscode) {
      vscode.postMessage({ type: 'promptForLink' });
    }
  });

  document.getElementById('btn-wikilink')?.addEventListener('click', () => {
    if (vscode) {
      vscode.postMessage({ type: 'searchWikilink' });
    }
  });

  document.getElementById('btn-search')?.addEventListener('click', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      metaKey: true
    }));
  });

  document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
    state.currentZoom += 1;
    document.documentElement.style.setProperty('--editor-zoom-level', `${state.currentZoom}px`);
  });

  document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
    if (state.currentZoom > 10) state.currentZoom -= 1;
    document.documentElement.style.setProperty('--editor-zoom-level', `${state.currentZoom}px`);
  });

  document.getElementById('btn-toggle')?.addEventListener('click', () => {
    const editorDiv = document.getElementById('editor');
    const sourceDiv = document.getElementById('source-editor');
    if (!editorDiv || !sourceDiv) return;

    state.isSourceMode = !state.isSourceMode;

    if (state.isSourceMode) {
      editorDiv.style.display = 'none';
      sourceDiv.style.display = 'block';

      const fullText = (state.currentFrontmatter ? state.currentFrontmatter : '') + state.lastMarkdown;
      if (!state.cmView) {
        initCodeMirror(fullText);
      } else {
        state.isUpdatingFromVSCode = true;
        state.cmView.dispatch({
          changes: { from: 0, to: state.cmView.state.doc.length, insert: fullText },
        });
        setTimeout(() => {
          state.isUpdatingFromVSCode = false;
        }, 50);
      }
    } else {
      sourceDiv.style.display = 'none';
      editorDiv.style.display = 'flex';
    }
    
    if (vscode) {
      vscode.postMessage({ type: 'toggleEditor' });
    }
  });

  document.getElementById('btn-image')?.addEventListener('click', () => {
    if (vscode) {
      vscode.postMessage({ type: 'promptForImage' });
    }
  });

  document.getElementById('btn-open-text')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openInTextEditor' });
  });

  document.getElementById('btn-toc')?.addEventListener('click', () => {
    if (vscode) {
      vscode.postMessage({ type: 'insertTOC' });
    }
  });

  document.getElementById('btn-export-pdf')?.addEventListener('click', () => {
    if (vscode) {
      vscode.postMessage({ type: 'showInfo', message: 'Preparing PDF export...' });
      const htmlContent = document.documentElement.outerHTML;
      vscode.postMessage({ type: 'exportPdf', html: htmlContent });
    }
  });

  document.getElementById('btn-copy')?.addEventListener('click', async () => {
    try {
      const editorDiv = document.querySelector('.milkdown .editor') as HTMLElement;
      if (!editorDiv) return;
      const html = editorDiv.innerHTML;
      const text = editorDiv.innerText;
      
      const blobHtml = new Blob([html], { type: 'text/html' });
      const blobText = new Blob([text], { type: 'text/plain' });
      const item = new ClipboardItem({
        'text/html': blobHtml,
        'text/plain': blobText
      });
      await navigator.clipboard.write([item]);
      
      const btn = document.getElementById('btn-copy');
      if (btn) {
        const origColor = btn.style.color;
        btn.style.color = 'var(--vscode-testing-iconPassed)';
        setTimeout(() => { btn.style.color = origColor; }, 1000);
      }
    } catch(err: any) {
      console.error(err);
      if (vscode) vscode.postMessage({ type: 'logError', message: 'Failed to copy rich text: ' + err.message });
    }
  });
}

function setupContextMenuEvents() {
  document.addEventListener('click', () => {
    const menu = document.getElementById('table-context-menu');
    const textMenu = document.getElementById('text-context-menu');
    const imageMenu = document.getElementById('image-context-menu');
    if (menu) menu.style.display = 'none';
    if (textMenu) textMenu.style.display = 'none';
    if (imageMenu) imageMenu.style.display = 'none';
  });

  document.querySelectorAll('#admonition-menu .dropdown-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      const val = (e.target as HTMLElement).getAttribute('data-val');
      if (val && state.editor) {
        const placeholder = state.configLang === 'vi' ? 'Nội dung...' : 'Content...';
        state.editor.action(insert(`\n> [!${val}]\n> ${placeholder}\n\n`));
      }
    });
  });

  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'IMG') return; // Handled by image observer

    const table = target.closest('table');
    const menu = document.getElementById('table-context-menu');
    const textMenu = document.getElementById('text-context-menu');

    if (menu) menu.style.display = 'none';
    if (textMenu) textMenu.style.display = 'none';

    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      e.preventDefault();
      if (textMenu) {
        textMenu.style.display = 'block';
        textMenu.style.left = `${e.pageX}px`;
        textMenu.style.top = `${e.pageY}px`;
      }
    } else if (table) {
      e.preventDefault();
      if (menu) {
        menu.style.display = 'block';
        menu.style.left = `${e.pageX}px`;
        menu.style.top = `${e.pageY}px`;
      }
    }
  });

  document.getElementById('ctx-send-to-ai')?.addEventListener('click', () => {
    import('../communication').then(({ handleVSCodeCommand }) => {
      handleVSCodeCommand('sendToAI');
    });
  });

  document.getElementById('ctx-img-rename')?.addEventListener('click', () => {
    if (targetImage && vscode) {
      let rawSrc = targetImage.getAttribute('data-raw-src') || targetImage.getAttribute('src') || '';
      
      // Fallback if data-raw-src was lost and src contains vscode internal uri
      if (rawSrc.startsWith('vscode-webview:') || rawSrc.startsWith('https://file+.vscode-resource')) {
        const root = state.workspaceRoot ? (state.workspaceRoot.endsWith('/') ? state.workspaceRoot.slice(0, -1) : state.workspaceRoot) : '';
        if (root && rawSrc.includes(root)) {
           rawSrc = rawSrc.substring(rawSrc.indexOf(root) + root.length);
           // Remove publicPathPrefix if it was added
           const prefix = state.publicPathPrefix ? (state.publicPathPrefix.startsWith('/') ? state.publicPathPrefix : '/' + state.publicPathPrefix) : '';
           if (prefix && rawSrc.startsWith(prefix)) {
             rawSrc = rawSrc.substring(prefix.length);
             if (!rawSrc.startsWith('/')) rawSrc = '/' + rawSrc;
           }
        }
      }

      vscode.postMessage({
        type: 'renameImage',
        src: rawSrc,
      });
      targetImage = null;
    }
  });

  document.getElementById('ctx-img-reveal')?.addEventListener('click', () => {
    if (targetImage && vscode) {
      let rawSrc = targetImage.getAttribute('data-raw-src') || targetImage.getAttribute('src') || '';
      
      if (rawSrc.startsWith('vscode-webview:') || rawSrc.startsWith('https://file+.vscode-resource')) {
        const root = state.workspaceRoot ? (state.workspaceRoot.endsWith('/') ? state.workspaceRoot.slice(0, -1) : state.workspaceRoot) : '';
        if (root && rawSrc.includes(root)) {
           rawSrc = rawSrc.substring(rawSrc.indexOf(root) + root.length);
           const prefix = state.publicPathPrefix ? (state.publicPathPrefix.startsWith('/') ? state.publicPathPrefix : '/' + state.publicPathPrefix) : '';
           if (prefix && rawSrc.startsWith(prefix)) {
             rawSrc = rawSrc.substring(prefix.length);
             if (!rawSrc.startsWith('/')) rawSrc = '/' + rawSrc;
           }
        }
      }

      vscode.postMessage({
        type: 'revealImage',
        src: rawSrc,
      });
      targetImage = null;
    }
  });

  document.getElementById('ctx-add-row')?.addEventListener('click', () => {
    if (state.editor) state.editor.action(callCommand(addRowAfterCommand.key));
  });
  document.getElementById('ctx-add-col')?.addEventListener('click', () => {
    if (state.editor) state.editor.action(callCommand(addColAfterCommand.key));
  });
  document.getElementById('ctx-del-row')?.addEventListener('click', () => {
    if (state.editor) {
      state.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        deleteRow(view.state, view.dispatch);
      });
    }
  });
  document.getElementById('ctx-del-col')?.addEventListener('click', () => {
    if (state.editor) {
      state.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        deleteColumn(view.state, view.dispatch);
      });
    }
  });
  document.getElementById('ctx-del-table')?.addEventListener('click', () => {
    if (state.editor) {
      state.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        deleteTable(view.state, view.dispatch);
      });
    }
  });
}

function setupTableModalEvents() {
  const tableModal = document.getElementById('table-modal');

  document.getElementById('btn-table')?.addEventListener('click', () => {
    if (tableModal) {
      tableModal.style.display = tableModal.style.display === 'block' ? 'none' : 'block';
    }
  });

  document.getElementById('btn-table-cancel')?.addEventListener('click', () => {
    if (tableModal) tableModal.style.display = 'none';
  });

  document.getElementById('btn-table-confirm')?.addEventListener('click', () => {
    if (tableModal) {
      tableModal.style.display = 'none';

      const rInput = document.getElementById('table-rows') as HTMLInputElement;
      const cInput = document.getElementById('table-cols') as HTMLInputElement;
      const r = parseInt(rInput?.value || '3');
      const c = parseInt(cInput?.value || '3');

      if (r > 0 && c > 0 && state.editor) {
        let tableMd = '\n';
        for (let i = 0; i < c; i++) tableMd += '|   ';
        tableMd += '|\n';
        for (let i = 0; i < c; i++) tableMd += '| --- ';
        tableMd += '|\n';
        for (let i = 0; i < r; i++) {
          for (let j = 0; j < c; j++) tableMd += '|   ';
          tableMd += '|\n';
        }
        state.editor.action(insert(tableMd + '\n'));
      }
    }
  });
}

function setupFindWidgetEvents() {
    const findWidget = document.getElementById('find-widget');
    const findInput = document.getElementById('find-input') as HTMLInputElement;
    const replaceRow = document.getElementById('replace-row');
    const replaceInput = document.getElementById('replace-input') as HTMLInputElement;
    const countSpan = document.getElementById('find-count');
    const btnCase = document.getElementById('btn-find-case');
    
    let isReplaceMode = false;
    let matchCase = false;
    
    function updateSearchState(searchTerm: string, updateStateOnly = false) {
        if (!state.editor) return;
        state.editor.action((ctx) => {
            try {
                const view = ctx.get(editorViewCtx);
                if (!view || !view.state) return;
                const tr = view.state.tr;
                tr.setMeta(searchPluginKey, { searchTerm, matchCase });
                view.dispatch(tr);
                
                if (!updateStateOnly) {
                    updateUI(view.state);
                }
            } catch (e) {
                // Ignore context not ready
            }
        });
    }
    
    function updateUI(pmState: any) {
        const searchState = searchPluginKey.getState(pmState);
        if (searchState) {
            const total = searchState.matches.length;
            if (total === 0) {
                if (countSpan) countSpan.textContent = findInput?.value ? 'No results' : '';
            } else {
                const active = searchState.activeIndex + 1;
                if (countSpan) countSpan.textContent = `${active} of ${total}`;
            }
        }
    }
    
    function nextMatch(dir: number) {
        if (!state.editor) return;
        state.editor.action((ctx) => {
            try {
                const view = ctx.get(editorViewCtx);
                if (!view || !view.state) return;
                const searchState = searchPluginKey.getState(view.state);
                if (!searchState || searchState.matches.length === 0) return;
                
                let nextIndex = searchState.activeIndex + dir;
                if (nextIndex < 0) nextIndex = searchState.matches.length - 1;
                if (nextIndex >= searchState.matches.length) nextIndex = 0;
                
                const tr = view.state.tr;
                tr.setMeta(searchPluginKey, { activeIndex: nextIndex });
                view.dispatch(tr);
                updateUI(view.state);
            } catch(e) {}
        });
    }

    function doReplace() {
        if (!state.editor) return;
        state.editor.action((ctx) => {
            try {
                const view = ctx.get(editorViewCtx);
                if (!view || !view.state) return;
                const searchState = searchPluginKey.getState(view.state);
                if (!searchState || searchState.matches.length === 0 || searchState.activeIndex < 0) return;
                
                const match = searchState.matches[searchState.activeIndex];
                const replaceText = replaceInput.value;
                const tr = view.state.tr;
                tr.insertText(replaceText, match.from, match.to);
                view.dispatch(tr);
            } catch(e) {}
        });
    }

    function doReplaceAll() {
        if (!state.editor) return;
        state.editor.action((ctx) => {
            try {
                const view = ctx.get(editorViewCtx);
                if (!view || !view.state) return;
                const searchState = searchPluginKey.getState(view.state);
                if (!searchState || searchState.matches.length === 0) return;
                
                const tr = view.state.tr;
                const replaceText = replaceInput.value;
                for (let i = searchState.matches.length - 1; i >= 0; i--) {
                    const match = searchState.matches[i];
                    tr.insertText(replaceText, match.from, match.to);
                }
                view.dispatch(tr);
            } catch(e) {}
        });
    }

    function showWidget(replace: boolean) {
        isReplaceMode = replace;
        if (findWidget) findWidget.classList.add('visible');
        if (replaceRow) replaceRow.style.display = replace ? 'flex' : 'none';
        
        const icon = document.getElementById('icon-find-toggle');
        if (icon) icon.style.transform = isReplaceMode ? 'rotate(90deg)' : 'rotate(0deg)';
        
        findInput?.focus();
        findInput?.select();
        
        updateSearchState(findInput?.value || '');
    }
    
    function hideWidget() {
        if (findWidget) findWidget.classList.remove('visible');
        updateSearchState('', true);
        
        if (state.editor) {
            state.editor.action((ctx) => {
                try {
                    const view = ctx.get(editorViewCtx);
                    if (view) view.focus();
                } catch(e) {}
            });
        }
    }

    findInput?.addEventListener('input', () => {
        updateSearchState(findInput.value);
    });
    
    findInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            nextMatch(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
            hideWidget();
        }
    });

    replaceInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) {
                doReplaceAll();
            } else {
                doReplace();
            }
        } else if (e.key === 'Escape') {
            hideWidget();
        }
    });

    document.getElementById('btn-find-next')?.addEventListener('click', () => nextMatch(1));
    document.getElementById('btn-find-prev')?.addEventListener('click', () => nextMatch(-1));
    document.getElementById('btn-find-close')?.addEventListener('click', () => hideWidget());
    document.getElementById('btn-replace')?.addEventListener('click', () => doReplace());
    document.getElementById('btn-replace-all')?.addEventListener('click', () => doReplaceAll());
    
    document.getElementById('btn-find-toggle')?.addEventListener('click', () => {
        isReplaceMode = !isReplaceMode;
        if (replaceRow) replaceRow.style.display = isReplaceMode ? 'flex' : 'none';
        const icon = document.getElementById('icon-find-toggle');
        if (icon) icon.style.transform = isReplaceMode ? 'rotate(90deg)' : 'rotate(0deg)';
    });
    
    btnCase?.addEventListener('click', () => {
        matchCase = !matchCase;
        btnCase.classList.toggle('active', matchCase);
        updateSearchState(findInput?.value || '');
    });

    document.addEventListener('keydown', (e) => {
        const cmdKey = e.metaKey || e.ctrlKey;
        if (cmdKey && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            showWidget(e.altKey);
        }
        if (e.key === 'Escape' && findWidget?.classList.contains('visible')) {
            hideWidget();
        }
    });
    
    document.addEventListener('keyup', () => {
        if (findWidget?.classList.contains('visible') && state.editor) {
            state.editor.action((ctx) => {
                try {
                    const view = ctx.get(editorViewCtx);
                    if (view && view.state) {
                        updateUI(view.state);
                    }
                } catch(e) {}
            });
        }
    });
}

function setupOtherEvents() {
  document.getElementById('metadata-content')?.addEventListener('input', (e) => {
    if (!state.isUpdatingFromVSCode) {
      const target = e.target as HTMLElement;
      const yaml = target.innerText || '';
      const newFrontmatter = yaml.trim() ? `---\n${yaml.trim()}\n---\n` : '';
      state.currentFrontmatter = newFrontmatter;
      if (vscode) {
        vscode.postMessage({
          type: 'edit',
          text: newFrontmatter + state.lastMarkdown,
        });
      }

      if (state.isSourceMode && state.cmView) {
        state.isUpdatingFromVSCode = true;
        const fullText = newFrontmatter + state.lastMarkdown;
        state.cmView.dispatch({
          changes: { from: 0, to: state.cmView.state.doc.length, insert: fullText },
        });
        setTimeout(() => {
          state.isUpdatingFromVSCode = false;
        }, 50);
      }
    }
  });
}

function setupBookmarkTooltip() {
  const tooltip = document.createElement('div');
  tooltip.id = 'bookmark-tooltip';
  tooltip.className = 'bookmark-tooltip';
  tooltip.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-message-square-text" style="vertical-align: text-bottom; margin-right: 4px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/></svg> Add Annotation';
  document.body.appendChild(tooltip);

  let hideTimeout: any;

  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.toString().trim().length === 0) {
      tooltip.classList.remove('visible');
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    tooltip.style.left = `${rect.left + (rect.width / 2) - 50}px`;
    tooltip.style.top = `${rect.top - 40}px`;
    tooltip.classList.add('visible');

    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      tooltip.classList.remove('visible');
    }, 3000);
  });

  tooltip.addEventListener('mousedown', (e) => {
    e.preventDefault(); // Prevent losing focus and selection
    const selection = window.getSelection();
    if (selection) {
      vscode.postMessage({ type: 'addBookmark', text: selection.toString().trim() });
      tooltip.classList.remove('visible');
      
      // Optionally show a notification in webview
      const notif = document.createElement('div');
      notif.className = 'bookmark-notification';
      notif.innerText = 'Annotation Added!';
      document.body.appendChild(notif);
      setTimeout(() => notif.remove(), 2000);
    }
  });
}
