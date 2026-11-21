// OSMOS Stealth Bridge preferences.
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODES = ['hide', 'keep', 'off'];
const MODE_LABELS = [
  'Hide the overlay',
  'Keep visible (testing only)',
  'Do nothing',
];

export default class OsmosBridgePrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
      title: 'Screen-share behaviour',
      description:
        'OSMOS hides its own windows while a screen share or recording is active. This is auto-hide during sharing, not a per-window capture exclusion.',
    });

    const modeRow = new Adw.ComboRow({
      title: 'When sharing starts',
      subtitle: 'Hide is the only mode meant for real meetings.',
      model: Gtk.StringList.new(MODE_LABELS),
    });
    modeRow.selected = Math.max(0, MODES.indexOf(settings.get_string('mode')));
    modeRow.connect('notify::selected', () => {
      settings.set_string('mode', MODES[modeRow.selected] ?? 'hide');
    });
    group.add(modeRow);

    const pinRow = new Adw.SwitchRow({
      title: 'Pin OSMOS on top and on all workspaces',
      subtitle: 'Wayland clients cannot raise their own windows; the Shell can.',
    });
    settings.bind('keep-above', pinRow, 'active', 0);
    group.add(pinRow);

    const idsRow = new Adw.EntryRow({
      title: 'Window app ids (comma separated)',
      text: settings.get_strv('app-ids').join(', '),
      showApplyButton: true,
    });
    const applyIds = () => {
      const next = idsRow.text
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      settings.set_strv('app-ids', next.length ? next : ['osmos']);
    };
    idsRow.connect('apply', applyIds);
    group.add(idsRow);

    page.add(group);
    window.add(page);
  }
}
