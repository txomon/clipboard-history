import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { DbusClient } from './lib/dbusClient.js';
import { ClipboardIntake } from './lib/clipboardIntake.js';
import { MenuController } from './lib/menuController.js';
import { openConfirmDialog } from './confirmDialog.js';

const INDICATOR_ICON = 'edit-paste-symbolic';
const DISCONNECTED_ICON = 'network-offline-symbolic';
const SETTING_KEY_TOGGLE_MENU = 'toggle-menu';

// Panel button. Owns its own menu and wires the three lib components.
const ClipboardIndicator = GObject.registerClass(
class ClipboardIndicator extends PanelMenu.Button {
  // `client` is null when the session bus could not be opened; the
  // indicator then only ever shows the unavailable placeholder.
  _init(extension, client, settings) {
    super._init(0, 'Ringboard Clipboard History', false);

    this._extension = extension;
    this._client = client;
    this._settings = settings;
    this._connected = false;
    this._intake = null;
    this._controller = null;
    this._shortcutBound = false;

    const hbox = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
    this._icon = new St.Icon({
      icon_name: DISCONNECTED_ICON,
      style_class: 'system-status-icon',
    });
    hbox.add_child(this._icon);
    hbox.add_child(PopupMenu.arrowIcon(St.Side.BOTTOM));
    this.add_child(hbox);

    this._buildDisconnectedMenu();
    if (!client) return;

    this._intake = new ClipboardIntake(client, settings);
    this._intake.setOnAddResult(ok => this._setConnected(ok));

    this._buildMenu();
    this._controller = new MenuController(client, settings, this._intake, this._historySection);
    this._wireMenuLifecycle();
    this._wireSettings();
    this._setServerPresent(false);
  }

  // Flip the panel icon between the regular paste glyph and a
  // network-offline glyph based on the latest intake submit result.
  _setConnected(ok) {
    if (this._connected === ok) return;
    this._connected = ok;
    this._icon.set_icon_name(ok ? INDICATOR_ICON : DISCONNECTED_ICON);
  }

  // Driven by the bus name watch. Swaps the menu between the history UI and
  // the unavailable placeholder, and runs intake only while a server owns
  // the name.
  setServerPresent(present) {
    console.log(`ringboard: server ${present ? 'appeared' : 'vanished'} on the session bus`);
    this._setServerPresent(present);
    if (present && this.menu.isOpen) {
      this._controller.onMenuOpen().catch(e => {
        console.warn(`ringboard: onMenuOpen failed: ${e.message}`);
      });
    }
  }

  _setServerPresent(present) {
    this._unavailableItem.actor.visible = !present;
    for (const item of this._serverItems) item.actor.visible = present;
    if (present) this._intake.enable();
    else this._intake.disable();
    this._setConnected(present);
  }

  _buildDisconnectedMenu() {
    this._unavailableItem = new PopupMenu.PopupMenuItem('Ringboard server unavailable');
    this._unavailableItem.setSensitive(false);
    this.menu.addMenuItem(this._unavailableItem);
  }

  _buildMenu() {
    // Search entry
    this._searchEntry = new St.Entry({
      name: 'searchEntry',
      style_class: 'search-entry ci-history-search-entry',
      can_focus: true,
      hint_text: 'Search…',
      track_hover: true,
      x_expand: true,
    });
    const searchItem = new PopupMenu.PopupBaseMenuItem({
      style_class: 'ci-history-search-section',
      reactive: false,
      can_focus: false,
    });
    searchItem.add_child(this._searchEntry);
    this.menu.addMenuItem(searchItem);
    this._serverItems = [searchItem];

    // History section inside a scroll view. The CSS class
    // `ci-history-menu-section` carries the max-height: 450px clamp.
    this._historySection = new PopupMenu.PopupMenuSection();
    this._scrollView = new St.ScrollView({
      style_class: 'ci-history-menu-section',
      overlay_scrollbars: true,
    });
    this._scrollView.add_child(this._historySection.actor);
    const scrollWrap = new PopupMenu.PopupMenuSection();
    scrollWrap.actor.add_child(this._scrollView);
    this.menu.addMenuItem(scrollWrap);
    this._serverItems.push(scrollWrap);

    const separator = new PopupMenu.PopupSeparatorMenuItem();
    this.menu.addMenuItem(separator);
    this._serverItems.push(separator);

    // Action row: prev | next | (spacer) | clear. Embedding St.Buttons in a
    // non-reactive PopupBaseMenuItem prevents the menu from auto-closing on
    // click — that's what makes pagination work without dismissing the menu.
    const actionsItem = new PopupMenu.PopupBaseMenuItem({
      style_class: 'ci-history-actions-section',
      reactive: false,
      can_focus: false,
    });
    const actionsBox = new St.BoxLayout({
      vertical: false,
      x_expand: true,
    });
    actionsItem.add_child(actionsBox);
    this.menu.addMenuItem(actionsItem);
    this._serverItems.push(actionsItem);

    const makeIconButton = (iconName, onClick) => {
      const btn = new St.Button({
        style_class: 'ci-action-btn',
        can_focus: true,
        x_expand: false,
      });
      btn.set_child(new St.Icon({
        icon_name: iconName,
        style_class: 'popup-menu-icon',
      }));
      btn.connect('clicked', onClick);
      return btn;
    };

    this._prevButton = makeIconButton('go-previous-symbolic',
      () => this._controller.prevPage());
    actionsBox.add_child(this._prevButton);

    this._nextButton = makeIconButton('go-next-symbolic',
      () => this._controller.nextPage());
    actionsBox.add_child(this._nextButton);

    actionsBox.add_child(new St.BoxLayout({ x_expand: true }));

    const clearButton = makeIconButton('edit-delete-symbolic', () => {
      this._controller.clearAll(() => this._confirmClear()).catch(e => {
        console.warn(`ringboard: clearAll failed: ${e.message}`);
      });
    });
    actionsBox.add_child(clearButton);
  }

  // Set the menu width to a fixed fraction of the primary monitor, matching
  // the upstream gnome-clipboard-history default. Without this the menu grows
  // to whatever its widest entry needs, which for long clipboard items is
  // unusable.
  _setMenuWidth() {
    const display = global.display;
    const geom = display.get_monitor_geometry(display.get_primary_monitor());
    this.menu.actor.width = Math.floor(geom.width * 0.35);
  }

  _wireMenuLifecycle() {
    this.menu.connect('open-state-changed', (_, open) => {
      if (open) {
        this._setMenuWidth();
        this._controller.onMenuOpen().catch(e => {
          console.warn(`ringboard: onMenuOpen failed: ${e.message}`);
        });
      } else {
        this._controller.onMenuClose();
      }
    });

    this._searchEntry.get_clutter_text().connect('text-changed', () => {
      this._controller.setQuery(this._searchEntry.get_text());
    });

    this._controller.setOnPageChanged(({ hasPrev, hasNext }) => {
      this._prevButton.reactive = hasPrev;
      this._prevButton.opacity = hasPrev ? 255 : 128;
      this._nextButton.reactive = hasNext;
      this._nextButton.opacity = hasNext ? 255 : 128;
    });
  }

  _wireSettings() {
    this._bindOrUnbindShortcut();
    this._settingsKbId = this._settings.connect('changed::enable-keybindings',
      () => this._bindOrUnbindShortcut());
    this._settingsToggleId = this._settings.connect(`changed::${SETTING_KEY_TOGGLE_MENU}`,
      () => this._bindOrUnbindShortcut());
  }

  _bindOrUnbindShortcut() {
    if (this._shortcutBound) {
      Main.wm.removeKeybinding(SETTING_KEY_TOGGLE_MENU);
      this._shortcutBound = false;
    }
    if (!this._settings.get_boolean('enable-keybindings')) return;
    Main.wm.addKeybinding(
      SETTING_KEY_TOGGLE_MENU,
      this._settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
      () => this.menu.toggle(),
    );
    this._shortcutBound = true;
  }

  async _confirmClear() {
    return await new Promise(resolve => {
      openConfirmDialog(
        'Clear clipboard history',
        'This will remove every entry from the Ringboard server. Continue?',
        '',
        'Clear',
        'Cancel',
        () => resolve(true),
        () => resolve(false),
      );
    });
  }

  destroy() {
    if (this._shortcutBound) {
      Main.wm.removeKeybinding(SETTING_KEY_TOGGLE_MENU);
      this._shortcutBound = false;
    }
    if (this._settings) {
      if (this._settingsKbId) this._settings.disconnect(this._settingsKbId);
      if (this._settingsToggleId) this._settings.disconnect(this._settingsToggleId);
    }
    if (this._intake) {
      this._intake.disable();
      this._intake = null;
    }
    if (this._controller) {
      this._controller.onMenuClose();
      this._controller.dispose();
      this._controller = null;
    }
    super.destroy();
  }
});

export default class RingboardExtension extends Extension {
  enable() {
    const settings = this.getSettings();

    let client = null;
    try {
      client = new DbusClient();
    } catch (e) {
      console.warn(`ringboard: failed to open session bus: ${e.message}`);
    }
    this._client = client;
    this._indicator = new ClipboardIndicator(this, client, settings);
    Main.panel.addToStatusArea('ringboard-clipboard-history', this._indicator, 1, 'right');

    // The server may start after the shell (it is ordered after
    // graphical-session.target) or restart later, so follow the bus name for
    // the whole session instead of probing once.
    if (client) {
      this._watchId = client.watch(present => this._indicator.setServerPresent(present));
    }
  }

  disable() {
    if (this._watchId) {
      this._client.unwatch(this._watchId);
      this._watchId = 0;
    }
    this._client = null;
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
  }
}
