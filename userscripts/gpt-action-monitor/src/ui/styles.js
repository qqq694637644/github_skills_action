export const MONITOR_CSS = `
    #gpt-action-monitor {
      position: fixed;
      right: 0;
      top: 36vh;
      width: 30px;
      height: 40px;
      z-index: 2147483647;
      color: CanvasText;
      color-scheme: light dark;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.35;
    }
    #gpt-action-monitor button { font: inherit; }
    #gpt-action-monitor .gam-compact {
      position: relative;
      width: 30px;
      height: 40px;
    }
    #gpt-action-monitor .gam-handle {
      box-sizing: border-box;
      width: 30px;
      height: 40px;
      display: grid;
      place-items: center;
      padding: 0;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-right: 0;
      border-radius: 13px 0 0 13px;
      background: color-mix(in srgb, Canvas 97%, CanvasText 3%);
      color: CanvasText;
      box-shadow: 0 3px 10px rgba(0, 0, 0, .08);
      cursor: grab;
      touch-action: none;
    }
    #gpt-action-monitor.gam-detached .gam-handle {
      border-right: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 13px;
    }
    #gpt-action-monitor .gam-handle:hover,
    #gpt-action-monitor .gam-handle:focus-visible {
      background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
    }
    #gpt-action-monitor .gam-dot {
      width: 8px;
      height: 8px;
      display: inline-block;
      flex: 0 0 8px;
      border-radius: 50%;
      background: #8b8b8b;
    }
    #gpt-action-monitor[data-status="active"] .gam-dot { background: #22a35a; }
    #gpt-action-monitor[data-status="error"] .gam-dot { background: #d84a4a; }
    #gpt-action-monitor .gam-chip {
      position: absolute;
      right: 36px;
      top: 2px;
      width: min(250px, calc(100vw - 54px));
      height: 36px;
      box-sizing: border-box;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 7px;
      padding: 0 11px;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, CanvasText 13%, transparent);
      border-radius: 18px;
      background: color-mix(in srgb, Canvas 97%, CanvasText 3%);
      box-shadow: 0 3px 12px rgba(0, 0, 0, .08);
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transform: translateX(6px);
      transition: opacity .12s ease, transform .12s ease;
    }
    #gpt-action-monitor.gam-chip-right .gam-chip {
      right: auto;
      left: 36px;
      transform: translateX(-6px);
    }
    #gpt-action-monitor.gam-chip-visible .gam-chip,
    #gpt-action-monitor .gam-compact:hover .gam-chip,
    #gpt-action-monitor .gam-compact:focus-within .gam-chip {
      opacity: 1;
      transform: translateX(0);
    }
    #gpt-action-monitor .gam-current-action {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 600;
    }
    #gpt-action-monitor .gam-current-detail {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      opacity: .62;
    }
    #gpt-action-monitor.gam-dragging .gam-chip { opacity: 0; }
    #gpt-action-monitor.gam-dragging .gam-handle,
    #gpt-action-monitor.gam-dragging .gam-header { cursor: grabbing; }
    #gpt-action-monitor .gam-expanded { display: none; }
    #gpt-action-monitor.gam-open {
      width: min(320px, calc(100vw - 16px));
      height: min(300px, 54vh);
    }
    #gpt-action-monitor.gam-open .gam-compact { display: none; }
    #gpt-action-monitor.gam-open .gam-expanded {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-sizing: border-box;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 12px;
      background: color-mix(in srgb, Canvas 98%, CanvasText 2%);
      color: CanvasText;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .12);
    }
    #gpt-action-monitor .gam-header {
      height: 38px;
      flex: 0 0 38px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px 0 12px;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
      font-size: 12px;
      font-weight: 600;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    #gpt-action-monitor .gam-header > span {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    #gpt-action-monitor .gam-header-controls {
      display: flex;
      align-items: center;
      gap: 3px;
    }
    #gpt-action-monitor .gam-skills-button,
    #gpt-action-monitor .gam-skills-refresh {
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    #gpt-action-monitor .gam-skills-button {
      height: 28px;
      padding: 0 7px;
      font-size: 11px;
      font-weight: 600;
    }
    #gpt-action-monitor .gam-skills-button:hover,
    #gpt-action-monitor .gam-skills-button:focus-visible,
    #gpt-action-monitor .gam-skills-refresh:hover,
    #gpt-action-monitor .gam-skills-refresh:focus-visible {
      background: color-mix(in srgb, CanvasText 7%, transparent);
    }
    #gpt-action-monitor .gam-close {
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 17px;
      line-height: 1;
    }
    #gpt-action-monitor .gam-close:hover { background: color-mix(in srgb, CanvasText 7%, transparent); }
    #gpt-action-monitor .gam-log {
      flex: 1;
      overflow-y: auto;
      padding: 6px 8px 8px;
      scrollbar-width: thin;
    }
    #gpt-action-monitor .gam-entry {
      padding: 7px 8px;
      border-radius: 8px;
    }
    #gpt-action-monitor .gam-entry:hover { background: color-mix(in srgb, CanvasText 5%, transparent); }
    #gpt-action-monitor .gam-entry-top {
      display: flex;
      gap: 8px;
      align-items: baseline;
      min-width: 0;
    }
    #gpt-action-monitor .gam-time {
      flex: 0 0 auto;
      opacity: .48;
      font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    #gpt-action-monitor .gam-action {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    #gpt-action-monitor .gam-detail {
      margin: 2px 0 0 42px;
      opacity: .62;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #gpt-action-monitor .gam-hint { opacity: .58; }
    #gpt-action-monitor .gam-skills-menu {
      position: absolute;
      inset: 38px 0 0;
      z-index: 3;
      display: grid;
      grid-template-columns: minmax(135px, .9fr) minmax(0, 1.1fr);
      min-height: 0;
      background: color-mix(in srgb, Canvas 98%, CanvasText 2%);
    }
    #gpt-action-monitor .gam-skills-menu[hidden] { display: none; }
    #gpt-action-monitor .gam-skills-primary {
      min-width: 0;
      display: flex;
      flex-direction: column;
      border-right: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
    }
    #gpt-action-monitor .gam-skills-menu-header {
      height: 34px;
      flex: 0 0 34px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 7px 0 10px;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, transparent);
      font-size: 11px;
    }
    #gpt-action-monitor .gam-skills-refresh {
      width: 26px;
      height: 26px;
      padding: 0;
      font-size: 16px;
      line-height: 1;
    }
    #gpt-action-monitor .gam-skills-list {
      min-height: 0;
      overflow-y: auto;
      padding: 5px;
      scrollbar-width: thin;
    }
    #gpt-action-monitor .gam-skill-item {
      width: 100%;
      min-height: 32px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
      padding: 5px 7px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: left;
    }
    #gpt-action-monitor .gam-skill-item:hover,
    #gpt-action-monitor .gam-skill-item:focus-visible {
      background: color-mix(in srgb, CanvasText 7%, transparent);
      outline: none;
    }
    #gpt-action-monitor .gam-skill-id {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    #gpt-action-monitor .gam-skill-chevron { opacity: .45; font-size: 15px; }
    #gpt-action-monitor .gam-skills-state {
      padding: 12px 10px;
      color: color-mix(in srgb, CanvasText 58%, transparent);
      font-size: 11px;
    }
    #gpt-action-monitor .gam-skills-detail {
      min-width: 0;
      overflow-y: auto;
      padding: 12px;
      scrollbar-width: thin;
    }
    #gpt-action-monitor .gam-skills-detail[hidden] { display: none; }
    #gpt-action-monitor .gam-skills-detail-description {
      color: color-mix(in srgb, CanvasText 68%, transparent);
      font-size: 11px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    @media (prefers-reduced-motion: reduce) {
      #gpt-action-monitor .gam-chip { transition: none; }
    }
  `;

export const SETTINGS_CSS = `
      #gam-settings-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        padding: 20px;
        box-sizing: border-box;
        background: rgba(0, 0, 0, .28);
        color-scheme: light dark;
        font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #gam-settings-overlay * { box-sizing: border-box; }
      #gam-settings-overlay .gam-settings-card {
        width: min(620px, 100%);
        max-height: min(720px, calc(100vh - 40px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
        border-radius: 14px;
        background: Canvas;
        color: CanvasText;
        box-shadow: 0 18px 48px rgba(0, 0, 0, .22);
      }
      #gam-settings-overlay .gam-settings-header {
        height: 52px;
        flex: 0 0 52px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 14px 0 18px;
        border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
      }
      #gam-settings-overlay .gam-settings-title { font-size: 15px; font-weight: 650; }
      #gam-settings-overlay button,
      #gam-settings-overlay input { font: inherit; }
      #gam-settings-overlay button { color: inherit; }
      #gam-settings-overlay .gam-icon-button {
        width: 30px;
        height: 30px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        cursor: pointer;
        font-size: 19px;
      }
      #gam-settings-overlay .gam-icon-button:hover { background: color-mix(in srgb, CanvasText 7%, transparent); }
      #gam-settings-overlay .gam-settings-body {
        min-height: 0;
        overflow-y: auto;
        padding: 14px 16px 16px;
      }
      #gam-settings-overlay .gam-settings-note {
        margin: 0 0 12px;
        color: color-mix(in srgb, CanvasText 62%, transparent);
        font-size: 12px;
      }
      #gam-settings-overlay .gam-profile-list { display: grid; gap: 8px; }
      #gam-settings-overlay .gam-profile-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        min-height: 58px;
        padding: 9px 10px 9px 12px;
        border: 1px solid color-mix(in srgb, CanvasText 11%, transparent);
        border-radius: 10px;
      }
      #gam-settings-overlay .gam-profile-main { min-width: 0; }
      #gam-settings-overlay .gam-profile-name-line {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
      }
      #gam-settings-overlay .gam-profile-state {
        width: 7px;
        height: 7px;
        flex: 0 0 7px;
        border-radius: 50%;
        background: #22a35a;
      }
      #gam-settings-overlay .gam-profile-row[data-enabled="false"] .gam-profile-state { background: #8b8b8b; }
      #gam-settings-overlay .gam-profile-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 620;
      }
      #gam-settings-overlay .gam-profile-backend {
        margin: 3px 0 0 14px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: color-mix(in srgb, CanvasText 58%, transparent);
        font-size: 12px;
      }
      #gam-settings-overlay .gam-button {
        min-height: 32px;
        padding: 5px 11px;
        border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
        border-radius: 8px;
        background: color-mix(in srgb, Canvas 96%, CanvasText 4%);
        cursor: pointer;
      }
      #gam-settings-overlay .gam-button:hover { background: color-mix(in srgb, Canvas 91%, CanvasText 9%); }
      #gam-settings-overlay .gam-button:disabled { cursor: default; opacity: .5; }
      #gam-settings-overlay .gam-button-primary {
        border-color: #2f7d4b;
        background: #237a42;
        color: white;
      }
      #gam-settings-overlay .gam-button-primary:hover { background: #1d6938; }
      #gam-settings-overlay .gam-list-footer {
        display: flex;
        justify-content: flex-start;
        margin-top: 12px;
      }
      #gam-settings-overlay .gam-empty {
        padding: 34px 18px;
        border: 1px dashed color-mix(in srgb, CanvasText 18%, transparent);
        border-radius: 10px;
        text-align: center;
        color: color-mix(in srgb, CanvasText 58%, transparent);
      }
      #gam-settings-overlay .gam-editor { display: grid; gap: 13px; }
      #gam-settings-overlay .gam-editor[hidden],
      #gam-settings-overlay .gam-list-view[hidden] { display: none; }
      #gam-settings-overlay .gam-field { display: grid; gap: 6px; }
      #gam-settings-overlay .gam-field > span { font-weight: 600; }
      #gam-settings-overlay .gam-input {
        width: 100%;
        height: 36px;
        padding: 0 10px;
        border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
        border-radius: 8px;
        background: Canvas;
        color: CanvasText;
        outline: none;
      }
      #gam-settings-overlay .gam-input:focus { border-color: #4f8e68; box-shadow: 0 0 0 2px rgba(35, 122, 66, .12); }
      #gam-settings-overlay .gam-token-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
      #gam-settings-overlay .gam-check-row { display: flex; gap: 8px; align-items: center; }
      #gam-settings-overlay .gam-form-message { min-height: 19px; font-size: 12px; }
      #gam-settings-overlay .gam-form-message[data-state="error"] { color: #c53e3e; }
      #gam-settings-overlay .gam-form-message[data-state="success"] { color: #238349; }
      #gam-settings-overlay .gam-form-message[data-state="pending"] { color: color-mix(in srgb, CanvasText 60%, transparent); }
      #gam-settings-overlay .gam-editor-footer {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 2px;
      }
      #gam-settings-overlay .gam-editor-footer .gam-spacer { flex: 1; }
      #gam-settings-overlay .gam-delete { color: #b63c3c; }
      @media (max-width: 520px) {
        #gam-settings-overlay { padding: 8px; }
        #gam-settings-overlay .gam-settings-card { max-height: calc(100vh - 16px); }
        #gam-settings-overlay .gam-editor-footer { flex-wrap: wrap; }
      }
    `;
