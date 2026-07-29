import React, { useState } from 'react';
import { usePaneActivityStore } from '../state/paneActivityStore';
import { clearPaneNotification } from '../lib/paneActivity';
import './NotificationCenter.css';

const NotificationCenter: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const activities = usePaneActivityStore((state) => state.activities);

  const needsAttention = Array.from(activities.values()).filter(
    (activity) => activity.notificationState === 'needs_attention'
  );

  const handleDismiss = async (paneId: string) => {
    await clearPaneNotification(paneId);
  };

  const handleClearAll = async () => {
    await Promise.all(needsAttention.map((a) => clearPaneNotification(a.paneId)));
    setIsOpen(false);
  };

  return (
    <div className="notification-center">
      <button
        className="notification-bell"
        data-testid="notification-bell"
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Notifications"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 2C8 2 6 4 6 6v4L4 12v2h12v-2l-2-2V6c0-2-2-4-4-4zm0 16c1.1 0 2-.9 2-2H8c0 1.1.9 2 2 2z" />
        </svg>
        {needsAttention.length > 0 && (
          <span className="notification-badge">{needsAttention.length}</span>
        )}
      </button>

      {isOpen && (
        <div className="notification-dropdown">
          <div className="notification-header">
            <h3>Panes Needing Attention</h3>
            {needsAttention.length > 0 && (
              <button onClick={handleClearAll} className="clear-all-btn">
                Clear All
              </button>
            )}
          </div>
          <div className="notification-list">
            {needsAttention.length === 0 ? (
              <div className="no-notifications">No notifications</div>
            ) : (
              needsAttention.map((activity) => (
                <div key={activity.paneId} className="notification-item">
                  <div className="notification-content">
                    <div className="notification-command">
                      {activity.activeCommand?.cmd || 'Unknown command'}
                    </div>
                    <div className="notification-reason">
                      {activity.activeCommand?.exitCode !== null && activity.activeCommand?.exitCode !== 0
                        ? `Exit code ${activity.activeCommand?.exitCode}`
                        : 'Completed in background'}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDismiss(activity.paneId)}
                    className="dismiss-btn"
                    aria-label="Dismiss"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationCenter;
