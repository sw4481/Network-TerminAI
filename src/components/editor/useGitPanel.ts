import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  gitDiscoverRepositories,
  gitGetRepositoryState,
  gitWatchRepositories,
  type GitOperationResult,
  type GitRepositoryDescriptor,
  type GitRepositoryState,
} from "../../lib/tauri";
import {
  chooseActiveRepository,
  DEFAULT_GIT_PANEL_PREFERENCES,
  loadGitPanelPreferences,
  saveGitPanelPreferences,
  type GitDiffStyle,
  type GitPanelPreferences,
  type GitPanelTab,
} from "./gitPanelState";

type GitRepositoryChanged = { root: string };

export function useGitPanel({
  workspaceRoot,
  focusedFile,
  enabled,
}: {
  workspaceRoot: string;
  focusedFile: string | null;
  enabled: boolean;
}) {
  const [preferences, setPreferences] = useState<GitPanelPreferences>(() =>
    workspaceRoot
      ? loadGitPanelPreferences(workspaceRoot)
      : { ...DEFAULT_GIT_PANEL_PREFERENCES },
  );
  const [repositories, setRepositories] = useState<GitRepositoryDescriptor[]>([]);
  const [repositoryState, setRepositoryState] =
    useState<GitRepositoryState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    setPreferences(
      workspaceRoot
        ? loadGitPanelPreferences(workspaceRoot)
        : { ...DEFAULT_GIT_PANEL_PREFERENCES },
    );
  }, [workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot) return;
    saveGitPanelPreferences(workspaceRoot, preferences);
  }, [preferences, workspaceRoot]);

  const patchPreferences = useCallback(
    (patch: Partial<GitPanelPreferences>) =>
      setPreferences((current) => ({ ...current, ...patch })),
    [],
  );

  const refreshState = useCallback(async (root?: string | null) => {
    const target = root ?? preferences.activeRepository;
    const observed = ++generation.current;
    if (!target) {
      setRepositoryState(null);
      return null;
    }
    try {
      const next = await gitGetRepositoryState(target);
      if (observed === generation.current) {
        setRepositoryState(next);
        setRepositories((current) =>
          current.map((repository) =>
            repository.root === next.repository.root
              ? next.repository
              : repository,
          ),
        );
        setError(null);
      }
      return next;
    } catch (nextError) {
      if (observed === generation.current) {
        setRepositoryState(null);
        setError(String(nextError));
      }
      return null;
    }
  }, [preferences.activeRepository]);

  const rescan = useCallback(async () => {
    if (!enabled || !workspaceRoot) {
      setRepositories([]);
      setRepositoryState(null);
      return [];
    }
    setLoading(true);
    setError(null);
    try {
      const found = await gitDiscoverRepositories(
        workspaceRoot,
        preferences.additionalRepositories,
      );
      setRepositories(found);
      const active = chooseActiveRepository(
        found,
        focusedFile,
        preferences.activeRepository,
        workspaceRoot,
      );
      patchPreferences({ activeRepository: active });
      await gitWatchRepositories(found.map((repository) => repository.root));
      await refreshState(active);
      return found;
    } catch (nextError) {
      setRepositories([]);
      setRepositoryState(null);
      setError(String(nextError));
      return [];
    } finally {
      setLoading(false);
    }
  }, [
    enabled,
    focusedFile,
    patchPreferences,
    preferences.activeRepository,
    preferences.additionalRepositories,
    refreshState,
    workspaceRoot,
  ]);

  useEffect(() => {
    void rescan();
    // Discovery intentionally follows workspace/manual-root changes. Focused
    // file selection is handled separately so changing tabs does not rescan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, workspaceRoot, preferences.additionalRepositories]);

  useEffect(() => {
    if (!enabled || repositories.length === 0) return;
    const active = chooseActiveRepository(
      repositories,
      focusedFile,
      preferences.activeRepository,
      workspaceRoot,
    );
    if (active !== preferences.activeRepository) {
      patchPreferences({ activeRepository: active });
    }
  }, [
    enabled,
    focusedFile,
    patchPreferences,
    preferences.activeRepository,
    repositories,
    workspaceRoot,
  ]);

  useEffect(() => {
    if (!enabled) return;
    void refreshState(preferences.activeRepository);
  }, [enabled, preferences.activeRepository, refreshState]);

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => void refreshState();
    const interval = window.setInterval(refresh, 10_000);
    window.addEventListener("focus", refresh);
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen<GitRepositoryChanged>("git-repository-changed", (event) => {
      if (!disposed && event.payload.root === preferences.activeRepository) {
        void refreshState(event.payload.root);
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      unlisten?.();
    };
  }, [enabled, preferences.activeRepository, refreshState]);

  const perform = useCallback(
    async (
      label: string,
      action: () => Promise<GitOperationResult>,
      options: { rescan?: boolean } = {},
    ) => {
      if (operation) return null;
      setOperation(label);
      setError(null);
      try {
        const result = await action();
        if (result.repository) {
          setRepositoryState(result.repository);
          setRepositories((current) =>
            current.map((repository) =>
              repository.root === result.repository!.repository.root
                ? result.repository!.repository
                : repository,
            ),
          );
        }
        if (!result.ok) setError(result.message || result.stderr);
        if (result.ok && options.rescan) await rescan();
        else if (result.ok) await refreshState();
        return result;
      } catch (nextError) {
        setError(String(nextError));
        return null;
      } finally {
        setOperation(null);
      }
    },
    [operation, refreshState, rescan],
  );

  const addLocalRepository = useCallback(
    (root: string) => {
      if (!root || preferences.additionalRepositories.includes(root)) return;
      patchPreferences({
        additionalRepositories: [...preferences.additionalRepositories, root],
        activeRepository: root,
      });
    },
    [patchPreferences, preferences.additionalRepositories],
  );

  const removeLocalRepository = useCallback(
    (root: string) => {
      patchPreferences({
        additionalRepositories: preferences.additionalRepositories.filter(
          (candidate) => candidate !== root,
        ),
        activeRepository:
          preferences.activeRepository === root
            ? null
            : preferences.activeRepository,
      });
    },
    [patchPreferences, preferences.activeRepository, preferences.additionalRepositories],
  );

  const activeRepository = useMemo(
    () =>
      repositories.find(
        (repository) => repository.root === preferences.activeRepository,
      ) ?? null,
    [preferences.activeRepository, repositories],
  );

  return {
    preferences,
    repositories,
    activeRepository,
    repositoryState,
    loading,
    error,
    operation,
    setOpen: (open: boolean) => patchPreferences({ open }),
    setWidth: (width: number) => patchPreferences({ width }),
    setSelectedTab: (selectedTab: GitPanelTab) =>
      patchPreferences({ selectedTab }),
    setDiffStyle: (diffStyle: GitDiffStyle) => patchPreferences({ diffStyle }),
    setActiveRepository: (activeRepository: string | null) =>
      patchPreferences({ activeRepository }),
    setError,
    rescan,
    refreshState,
    perform,
    addLocalRepository,
    removeLocalRepository,
  };
}

export type GitPanelController = ReturnType<typeof useGitPanel>;
