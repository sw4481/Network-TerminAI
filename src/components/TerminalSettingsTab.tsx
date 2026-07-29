import React, { useEffect, useState } from 'react';
import { getNotificationPreferences, updateNotificationPreferences, NotificationPreferences } from '../lib/paneActivity';
import './TerminalSettingsTab.css';

const TerminalSettingsTab: React.FC = () => {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadPreferences();
  }, []);

  const loadPreferences = async () => {
    try {
      const loaded = await getNotificationPreferences();
      setPrefs(loaded);
    } catch (error) {
      console.error('Failed to load notification preferences:', error);
    }
  };

  const handleSave = async () => {
    if (!prefs) return;

    setIsSaving(true);
    try {
      await updateNotificationPreferences(prefs);
      alert('Preferences saved successfully');
    } catch (error) {
      console.error('Failed to save preferences:', error);
      alert('Failed to save preferences');
    } finally {
      setIsSaving(false);
    }
  };

  if (!prefs) {
    return <div>Loading...</div>;
  }

  return (
    <div className="terminal-settings-tab">
      <h2>Notification Settings</h2>

      <div className="settings-group">
        <label htmlFor="min-duration">
          Minimum duration for notification (seconds):
        </label>
        <input
          id="min-duration"
          type="number"
          value={String(prefs.minDurationSecs)}
          onChange={(e) =>
            setPrefs({ ...prefs, minDurationSecs: parseInt(e.target.value, 10) })
          }
          min="1"
        />
      </div>

      <div className="settings-group">
        <label>
          <input
            type="checkbox"
            checked={prefs.notifyOnNonzeroExit}
            onChange={(e) =>
              setPrefs({ ...prefs, notifyOnNonzeroExit: e.target.checked })
            }
          />
          Notify on non-zero exit code
        </label>
      </div>

      <div className="settings-group">
        <label>
          <input
            type="checkbox"
            checked={prefs.notifyOnAgentOutput}
            onChange={(e) =>
              setPrefs({ ...prefs, notifyOnAgentOutput: e.target.checked })
            }
          />
          Notify on agent output
        </label>
      </div>

      <div className="settings-group">
        <label htmlFor="keywords">
          Keyword triggers (comma-separated):
        </label>
        <input
          id="keywords"
          type="text"
          value={prefs.keywordTriggers.join(', ')}
          onChange={(e) =>
            setPrefs({
              ...prefs,
              keywordTriggers: e.target.value.split(',').map((s) => s.trim()),
            })
          }
        />
      </div>

      <div className="settings-group">
        <label htmlFor="ignore-commands">
          Ignore commands (comma-separated):
        </label>
        <input
          id="ignore-commands"
          type="text"
          value={prefs.ignoreCommands.join(', ')}
          onChange={(e) =>
            setPrefs({
              ...prefs,
              ignoreCommands: e.target.value.split(',').map((s) => s.trim()),
            })
          }
        />
      </div>

      <div className="settings-group">
        <label>
          <input
            type="checkbox"
            checked={prefs.enableSound}
            onChange={(e) =>
              setPrefs({ ...prefs, enableSound: e.target.checked })
            }
          />
          Enable notification sound
        </label>
      </div>

      <button onClick={handleSave} disabled={isSaving} className="save-btn">
        {isSaving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
};

export default TerminalSettingsTab;
