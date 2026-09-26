import { useState, useEffect } from "react";
import { ImportMcpServer } from "../components/ImportMcpServer";
import { SkillsList } from "../components/SkillsList";
import { SkillDetail } from "../components/SkillDetail";
// import { SessionsList } from "../components/SessionsList";
import type { McpServerConfig } from "../lib/mcpConfigParser";
import { mcpListServers, mcpRemoveServer, mcpUpdateServerEnabled, mcpAddServer, type McpServer, skillsList, skillsReload, aiListModels, skillsCreate, aiSaveConfig, aiGetConfig, aiTestConnection, agentsList, agentsCreate, agentsUpdate, agentsDelete, type Agent, contextGraphGetEnabled, contextGraphSetEnabled, contextGraphGetStaleness, contextGraphSetStaleness } from "../lib/tauri";
import { useSkillsStore } from "../state/skillsStore";
import { useAgentsStore } from "../state/agentsStore";
import { FtpSettingsTab } from "./FtpSettingsTab";
import { TftpSettingsTab } from "./TftpSettingsTab";
import { RagSettingsTab } from "../components/RagSettingsTab";
import { PyatsSettingsTab } from "../components/settings/PyatsSettingsTab";
import { ProxmoxSettingsTab } from "../components/settings/ProxmoxSettingsTab";
import { AgentComputersSettingsTab } from "../components/settings/AgentComputersSettingsTab";
import StealthwatchSettingsTab from "../components/settings/StealthwatchSettingsTab";
import IseSettingsTab from "../components/settings/IseSettingsTab";
import VendorKeywordsSettingsTab from '../components/settings/VendorKeywordsSettingsTab';
import GitCiSettingsTab from '../components/settings/GitCiSettingsTab';
import UpdatesSettingsTab from '../components/settings/UpdatesSettingsTab';
import CmlSettingsTab from "../components/settings/CmlSettingsTab";
import CatalystCenterSettingsTab from "../components/settings/CatalystCenterSettingsTab";
import SplunkSettingsTab from "../components/settings/SplunkSettingsTab";
import AciSettingsTab from "../components/settings/AciSettingsTab";
import GnmiSettingsTab from "../components/settings/GnmiSettingsTab";
import FmcSettingsTab from "../components/settings/FmcSettingsTab";
import ThousandEyesSettingsTab from "../components/settings/ThousandEyesSettingsTab";
import MerakiSettingsTab from "../components/settings/MerakiSettingsTab";
import SecureEndpointSettingsTab from "../components/settings/SecureEndpointSettingsTab";
import CiscoXdrSettingsTab from "../components/settings/CiscoXdrSettingsTab";
import MistSettingsTab from "../components/settings/MistSettingsTab";
import GrafanaSettingsTab from "../components/settings/GrafanaSettingsTab";
import ZabbixSettingsTab from "../components/settings/ZabbixSettingsTab";
import PrometheusSettingsTab from "../components/settings/PrometheusSettingsTab";
import NetboxSettingsTab from "../components/settings/NetboxSettingsTab";
import SketchfabSettingsTab from "../components/settings/SketchfabSettingsTab";
import WhatsAppSettingsTab from "../components/settings/WhatsAppSettingsTab";
import TerminalSettingsTab from "../components/TerminalSettingsTab";
import SettingsBrowserTab from "../components/SettingsBrowserTab";
import EditorSettingsTab from "../components/settings/EditorSettingsTab";
import { AppearanceSettingsTab } from "../components/settings/AppearanceSettingsTab";
import { TopolographSettingsTab } from "../components/settings/TopolographSettingsTab";
import NetworkArchitectSettingsTab from "../components/settings/NetworkArchitectSettingsTab";
import { useAiChatPreferences } from "../hooks/useAiChatPreferences";
import { getSettingsTabGroups, type SettingsTabId } from "./settingsTabs";
// import { useSessionsStore } from "../state/sessionsStore";

type SettingsProps = {
  isOpen: boolean;
  onClose: () => void;
};

type AIProvider = "anthropic" | "openai" | "google" | "vllm" | "ollama" | "nvidia";

// Only these providers use a user-supplied base_url. Cloud providers have a
// fixed endpoint, so a base_url left over from a vllm/ollama setup must never
// be persisted for them (it would silently route to the wrong server).
const providerUsesBaseUrl = (p: AIProvider): boolean => p === "vllm" || p === "ollama";

const PROVIDER_MODELS: Record<AIProvider, string[]> = {
  anthropic: [
    "claude-opus-4-20250514",
    "claude-sonnet-4-20250514",
    "claude-sonnet-3-5-20241022",
    "claude-3-5-sonnet-20240620",
    "claude-3-opus-20240229",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307",
  ],
  openai: [
    "gpt-4-turbo-preview",
    "gpt-4-turbo",
    "gpt-4",
    "gpt-4-32k",
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-16k",
  ],
  google: [
    "gemini-2.0-flash-exp",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-1.0-pro",
  ],
  vllm: [
    "custom-model",
  ],
  ollama: [
    "llama3.3:latest",
    "llama3.2:latest",
    "llama3.1:latest",
    "mistral:latest",
    "mixtral:latest",
    "codellama:latest",
    "phi3:latest",
    "qwen2.5:latest",
  ],
  nvidia: [
    "meta/llama-3.3-70b-instruct",
    "nvidia/nemotron-4-340b-instruct",
    "mistralai/mixtral-8x7b-instruct-v0.1",
  ],
};

export function Settings({ isOpen, onClose }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("general");
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [showImport, setShowImport] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AI Provider settings
  const [aiProvider, setAIProvider] = useState<AIProvider>("anthropic");
  const [aiModel, setAIModel] = useState<string>("claude-sonnet-4-20250514");
  const [apiKey, setAPIKey] = useState<string>("");
  const [baseURL, setBaseURL] = useState<string>("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const {
    preferences: aiChatPreferences,
    updatePreferences: updateAiChatPreferences,
  } = useAiChatPreferences();

  // Master context-graph feature flag (default OFF). Toggling persists to
  // app_flags; the sidecar reads the same key so new agent runs pick it up.
  const [contextGraphEnabled, setContextGraphEnabled] = useState(false);
  // Staleness window in MINUTES for the UI (stored as seconds). Default 120 (2h).
  const [contextGraphStalenessMin, setContextGraphStalenessMin] = useState(120);

  const { setSkills, selectedSkill, selectSkill, skills: skillsInStore } = useSkillsStore();
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [showCreateSkill, setShowCreateSkill] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillDescription, setNewSkillDescription] = useState("");
  const [newSkillContent, setNewSkillContent] = useState("");
  const [newSkillScripts, setNewSkillScripts] = useState<File[]>([]);

  // Agents tab state
  const { setAgents: setAgentsInStore } = useAgentsStore();
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agents, setAgentsList] = useState<Agent[]>([]);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentDescription, setNewAgentDescription] = useState("");
  const [newAgentSystemPrompt, setNewAgentSystemPrompt] = useState("");
  const [newAgentUseOverride, setNewAgentUseOverride] = useState(false);
  const [newAgentProvider, setNewAgentProvider] = useState<AIProvider>("anthropic");
  const [newAgentModel, setNewAgentModel] = useState<string>("");
  const [newAgentAttachedSkills, setNewAgentAttachedSkills] = useState<string[]>([]);
  const [newAgentAttachedMcp, setNewAgentAttachedMcp] = useState<string[]>([]);
  const [newAgentAllowedCommands, setNewAgentAllowedCommands] = useState("");
  const [newAgentExecutionMode, setNewAgentExecutionMode] = useState<"react" | "code" | "react-code">("react");
  const [newAgentEngine, setNewAgentEngine] = useState<"deepagents" | "legacy" | null>("legacy");

  useEffect(() => {
    if (isOpen && activeTab === "mcp") {
      loadMcpServers();
    }
    if (isOpen && activeTab === "skills") {
      loadSkills();
    }
    if (isOpen && activeTab === "general") {
      loadAIConfig();
      contextGraphGetEnabled()
        .then(setContextGraphEnabled)
        .catch(() => {/* default off */});
      contextGraphGetStaleness()
        .then((secs) => setContextGraphStalenessMin(Math.max(1, Math.round(secs / 60))))
        .catch(() => {/* default 120 */});
    }
    if (isOpen && activeTab === "agents") {
      loadAgents();
    }
  }, [isOpen, activeTab]);

  const loadAgents = async () => {
    setAgentsLoading(true);
    setError(null);
    try {
      const list = await agentsList();
      setAgentsList(list);
      setAgentsInStore(list);
      // Ensure skills and mcp servers are available for selection
      if (mcpServers.length === 0) {
        try {
          const servers = await mcpListServers();
          setMcpServers(servers);
        } catch {
          /* ignore */
        }
      }
      try {
        const loadedSkills = await skillsList();
        setSkills(loadedSkills);
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load agents");
    } finally {
      setAgentsLoading(false);
    }
  };

  const closeAgentModal = () => {
    setShowCreateAgent(false);
    setEditingAgentId(null);
    setNewAgentExecutionMode("react");
    setNewAgentEngine("legacy");
  };

  const handleCreateAgent = async () => {
    if (!newAgentName.trim() || !newAgentSystemPrompt.trim()) {
      setError("Agent name and system prompt are required");
      return;
    }
    const allowedCommands = newAgentAllowedCommands
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      if (editingAgentId) {
        // Update existing agent
        await agentsUpdate(editingAgentId, {
          name: newAgentName.trim(),
          description: newAgentDescription.trim() || "No description",
          systemPrompt: newAgentSystemPrompt.trim(),
          modelOverride: newAgentUseOverride
            ? { provider: newAgentProvider, model: newAgentModel.trim() || "" }
            : null,
          attachedSkills: newAgentAttachedSkills,
          attachedMcpServers: newAgentAttachedMcp,
          allowedCommands,
          body: "",
          executionMode:
            newAgentExecutionMode === "react" ? undefined : newAgentExecutionMode,
          engine: newAgentEngine,
        });
      } else {
        // Create new agent
        await agentsCreate({
          name: newAgentName.trim(),
          description: newAgentDescription.trim() || "No description",
          systemPrompt: newAgentSystemPrompt.trim(),
          modelOverride: newAgentUseOverride
            ? { provider: newAgentProvider, model: newAgentModel.trim() || "" }
            : null,
          attachedSkills: newAgentAttachedSkills,
          attachedMcpServers: newAgentAttachedMcp,
          allowedCommands,
          body: "",
          executionMode:
            newAgentExecutionMode === "react" ? undefined : newAgentExecutionMode,
          engine: newAgentEngine,
        });
      }
      setShowCreateAgent(false);
      setEditingAgentId(null);
      setNewAgentName("");
      setNewAgentDescription("");
      setNewAgentSystemPrompt("");
      setNewAgentUseOverride(false);
      setNewAgentModel("");
      setNewAgentAttachedSkills([]);
      setNewAgentAttachedMcp([]);
      setNewAgentAllowedCommands("");
      setNewAgentExecutionMode("react");
      setNewAgentEngine("legacy");
      await loadAgents();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save agent");
    }
  };

  const handleEditAgent = (agent: Agent) => {
    setEditingAgentId(agent.id);
    setNewAgentName(agent.name);
    setNewAgentDescription(agent.description);
    setNewAgentSystemPrompt(agent.systemPrompt);
    if (agent.modelOverride) {
      setNewAgentUseOverride(true);
      setNewAgentProvider(agent.modelOverride.provider as AIProvider);
      setNewAgentModel(agent.modelOverride.model);
    } else {
      setNewAgentUseOverride(false);
      setNewAgentProvider("anthropic");
      setNewAgentModel("");
    }
    setNewAgentAttachedSkills(agent.attachedSkills);
    setNewAgentAttachedMcp(agent.attachedMcpServers);
    setNewAgentAllowedCommands(agent.allowedCommands.join("\n"));
    setNewAgentExecutionMode(agent.executionMode || "react");
    setNewAgentEngine(agent.engine || "legacy");
    setShowCreateAgent(true);
  };

  const handleDeleteAgent = async (id: string) => {
    if (!confirm(`Delete agent '${id}'? This cannot be undone.`)) return;
    try {
      await agentsDelete(id);
      await loadAgents();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete agent");
    }
  };

  const loadAIConfig = async () => {
    try {
      const config = await aiGetConfig();
      if (config) {
        setAIProvider(config.provider as AIProvider);
        setAIModel(config.model);
        setAPIKey(config.apiKey || "");
        setBaseURL(config.baseUrl || "");
        // Pass config values directly since state hasn't updated yet
        await loadModelsWithValues(
          config.provider as AIProvider,
          config.apiKey || "",
          config.baseUrl || ""
        );
      } else {
        // No saved config, use defaults
        await loadModelsWithValues(aiProvider, apiKey, baseURL);
      }
    } catch (e) {
      // Silent - just use fallback
    }
  };

  const loadModelsWithValues = async (provider: AIProvider, key: string, url: string) => {
    setModelsLoading(true);
    setError(null);
    try {
      // Check if we have required credentials before fetching
      const canFetch =
        (provider === "anthropic" && key) ||
        provider === "google" || // Google currently uses a static list
        (provider === "openai" && key) ||
        (provider === "nvidia" && key) ||
        (provider === "ollama") || // Ollama has default
        (provider === "vllm" && url);

      if (!canFetch) {
        // Use static fallback if credentials missing - NO ERROR
        setAvailableModels(PROVIDER_MODELS[provider]);
        setModelsLoading(false);
        return;
      }

      const models = await aiListModels({
        provider: provider,
        apiKey: key || undefined,
        baseUrl: url || undefined,
      });
      setAvailableModels(models);
      // Keep the selected model in sync with the freshly-fetched list. Without
      // this, `aiModel` stays at the static placeholder (e.g. vLLM's
      // "custom-model") even though the dropdown *displays* models[0] — so
      // Test/Save silently send the placeholder and the server 404s with
      // "The model `custom-model` does not exist". Only auto-pick when the
      // current selection isn't a real option in the new list.
      setAIModel((current) =>
        models.length > 0 && !models.includes(current) ? models[0] : current
      );
    } catch (e) {
      // Silently fallback to static list
      setAvailableModels(PROVIDER_MODELS[provider]);
    } finally {
      setModelsLoading(false);
    }
  };

  const loadModels = async () => {
    await loadModelsWithValues(aiProvider, apiKey, baseURL);
  };

  const loadMcpServers = async () => {
    setLoading(true);
    setError(null);
    try {
      const servers = await mcpListServers();
      setMcpServers(servers);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load MCP servers");
    } finally {
      setLoading(false);
    }
  };

  const loadSkills = async () => {
    setSkillsLoading(true);
    setError(null);
    try {
      await skillsReload();
      const loadedSkills = await skillsList();
      setSkills(loadedSkills);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load skills");
    } finally {
      setSkillsLoading(false);
    }
  };

  const handleCreateSkill = async () => {
    if (!newSkillName.trim() || !newSkillContent.trim()) {
      setError("Skill name and content are required");
      return;
    }

    try {
      // Prepare scripts array
      const scripts = await Promise.all(
        newSkillScripts.map(async (file) => ({
          name: file.name,
          content: await file.text(),
        }))
      );

      await skillsCreate({
        name: newSkillName.trim(),
        skillMdContent: newSkillContent.trim(),
        scripts,
      });
      setShowCreateSkill(false);
      setNewSkillName("");
      setNewSkillDescription("");
      setNewSkillContent("");
      setNewSkillScripts([]);
      await loadSkills();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create skill");
    }
  };

  const handleScriptUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setNewSkillScripts(Array.from(e.target.files));
    }
  };

  const handleImport = async (configs: McpServerConfig[]) => {
    try {
      for (const config of configs) {
        let commandJson: string | null = null;
        let url: string | null = null;
        let envJson: string | null = null;

        if (config.transport === "stdio") {
          commandJson = JSON.stringify({
            cmd: config.command,
            args: config.args || [],
          });
          if (config.env) {
            envJson = JSON.stringify(config.env);
          }
        } else {
          url = config.url || null;
        }

        await mcpAddServer({
          name: config.name,
          transport: config.transport,
          commandJson,
          url,
          envJson,
        });
      }

      await loadMcpServers();
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : "Failed to import servers");
    }
  };

  const toggleServer = async (id: string) => {
    try {
      const server = mcpServers.find((s) => s.id === id);
      if (!server) return;

      await mcpUpdateServerEnabled(id, !server.enabled);
      setMcpServers(
        mcpServers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle server");
    }
  };

  const deleteServer = async (id: string) => {
    if (!confirm("Are you sure you want to delete this server?")) {
      return;
    }

    try {
      await mcpRemoveServer(id);
      setMcpServers(mcpServers.filter((s) => s.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete server");
    }
  };

  if (!isOpen) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-window" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h1>Settings</h1>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-tabs">
            {getSettingsTabGroups().map(({ category, tabs }) => (
              <div key={category} className="settings-tab-group">
                {category !== "General" && (
                  <div className="settings-tab-category">{category}</div>
                )}
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    className={activeTab === tab.id ? "active" : ""}
                    aria-current={activeTab === tab.id ? "page" : undefined}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="settings-content">
        {activeTab === "general" && (
          <div className="tab-content">
            <h2>AI Provider Configuration</h2>
            <p className="muted" style={{ marginBottom: "24px" }}>
              Configure the AI provider and model used for all AI features (command translation, AI chat, skill invocation).
            </p>

            <div className="form-group">
              <label htmlFor="ai-provider">Provider</label>
              <select
                id="ai-provider"
                value={aiProvider}
                onChange={(e) => {
                  const provider = e.target.value as AIProvider;
                  setAIProvider(provider);
                  // Just use static models when switching provider
                  setAvailableModels(PROVIDER_MODELS[provider]);
                  if (PROVIDER_MODELS[provider].length > 0) {
                    setAIModel(PROVIDER_MODELS[provider][0]);
                  }
                  // User can click "Refresh Models" if they have credentials
                }}
              >
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI (GPT)</option>
                <option value="google">Google (Gemini)</option>
                <option value="nvidia">NVIDIA</option>
                <option value="vllm">vLLM (Custom)</option>
                <option value="ollama">Ollama (Local)</option>
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="ai-model">
                Model {modelsLoading && <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>(Loading...)</span>}
              </label>
              <select
                id="ai-model"
                value={aiModel}
                onChange={(e) => setAIModel(e.target.value)}
                disabled={modelsLoading}
              >
                {availableModels.length === 0 ? (
                  <option value="">No models available</option>
                ) : (
                  availableModels.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                onClick={() => {
                  // Check for required fields
                  if (aiProvider === "openai" && !apiKey) {
                    setError("Please enter your OpenAI API key first");
                    return;
                  }
                  if (aiProvider === "anthropic" && !apiKey) {
                    setError("Please enter your Anthropic API key first");
                    return;
                  }
                  if (aiProvider === "nvidia" && !apiKey) {
                    setError("Please enter your NVIDIA API key first");
                    return;
                  }
                  if (aiProvider === "vllm" && !baseURL) {
                    setError("Please enter your vLLM base URL first");
                    return;
                  }
                  loadModels();
                }}
                style={{
                  marginTop: "8px",
                  padding: "6px 12px",
                  background: "var(--surface-3)",
                  border: "none",
                  borderRadius: "4px",
                  color: "var(--text-primary)",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                🔄 Refresh Models
              </button>
            </div>

            {(aiProvider === "anthropic" || aiProvider === "openai" ||
              aiProvider === "google" || aiProvider === "nvidia") && (
              <div className="form-group">
                <label htmlFor="api-key">API Key</label>
                <input
                  id="api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setAPIKey(e.target.value)}
                  placeholder="Enter your API key"
                />
                <small className="hint">
                  {aiProvider === "anthropic" && "Get your key from console.anthropic.com"}
                  {aiProvider === "openai" && "Get your key from platform.openai.com"}
                  {aiProvider === "google" && "Get your key from makersuite.google.com"}
                  {aiProvider === "nvidia" && "Get your key from build.nvidia.com"}
                </small>
              </div>
            )}

            {(aiProvider === "vllm" || aiProvider === "ollama") && (
              <div className="form-group">
                <label htmlFor="base-url">Base URL</label>
                <input
                  id="base-url"
                  type="text"
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
                  placeholder={aiProvider === "ollama" ? "http://localhost:11434" : "http://localhost:8000"}
                />
                <small className="hint">
                  {aiProvider === "ollama" && "Default: http://localhost:11434"}
                  {aiProvider === "vllm" && "Your vLLM server endpoint"}
                </small>
              </div>
            )}

            {saveStatus && (
              <div style={{
                padding: "12px",
                marginBottom: "16px",
                borderRadius: "4px",
                background: saveStatus.type === "success" ? "color-mix(in srgb, var(--status-success) 18%, var(--surface-1))" : "color-mix(in srgb, var(--status-success) 18%, var(--surface-1))",
                border: `1px solid ${saveStatus.type === "success" ? "var(--status-success)" : "var(--status-success)"}`,
                color: saveStatus.type === "success" ? "var(--status-success)" : "var(--status-success)",
                fontSize: "13px",
              }}>
                {saveStatus.message}
              </div>
            )}

            <div className="form-actions">
              <button className="primary" onClick={async () => {
                console.log("Save button clicked", { aiProvider, aiModel, apiKey: apiKey ? "***" : "", baseURL });
                setSaveStatus({ type: "success", message: "Saving..." });
                try {
                  await aiSaveConfig({
                    provider: aiProvider,
                    model: aiModel,
                    apiKey: apiKey || undefined,
                    // Only vllm/ollama use a custom base_url. For cloud providers
                    // (nvidia/anthropic/openai/google) a stale base_url from a
                    // prior vllm setup must NOT leak through — it would route
                    // requests to the wrong endpoint. Send undefined so the
                    // backend uses the provider's correct default URL.
                    baseUrl: providerUsesBaseUrl(aiProvider) ? baseURL || undefined : undefined,
                  });
                  setSaveStatus({ type: "success", message: "✓ Configuration saved successfully!" });
                  setTimeout(() => setSaveStatus(null), 3000);
                } catch (e) {
                  const errorMsg = e instanceof Error ? e.message : String(e);
                  console.error("Save failed:", errorMsg);
                  setSaveStatus({ type: "error", message: `✗ Save failed: ${errorMsg}` });
                }
              }}>
                Save Configuration
              </button>
              <button className="secondary" onClick={async () => {
                console.log("Test button clicked", { aiProvider, aiModel, apiKey: apiKey ? "***" : "", baseURL });
                setSaveStatus({ type: "success", message: "Testing connection..." });
                try {
                  const result = await aiTestConnection({
                    provider: aiProvider,
                    model: aiModel,
                    apiKey: apiKey || undefined,
                    baseUrl: providerUsesBaseUrl(aiProvider) ? baseURL || undefined : undefined,
                  });
                  setSaveStatus({ type: "success", message: result });
                } catch (e) {
                  const errorMsg = e instanceof Error ? e.message : String(e);
                  console.error("Test failed:", errorMsg);
                  setSaveStatus({ type: "error", message: `✗ Connection failed: ${errorMsg}` });
                }
              }}>
                Test Connection
              </button>
            </div>

            <hr style={{ border: "none", borderTop: "1px solid var(--border-default)", margin: "28px 0 20px" }} />

            <h2>AI Chat</h2>
            <p className="muted" style={{ marginBottom: "16px" }}>
              Choose whether compatible tool agents show their answer as it is generated
              or wait and display the completed response at once.
            </p>
            <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <label className="toggle-switch" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  aria-label="Stream LLM output in AI Chat"
                  checked={aiChatPreferences.streamLlmOutput}
                  onChange={(event) => updateAiChatPreferences({
                    streamLlmOutput: event.target.checked,
                  })}
                />
                <span className="slider"></span>
              </label>
              <span>Stream LLM output in AI Chat</span>
            </div>
            <small className="hint">
              Off keeps the current completed-response behavior. The preference is
              saved on this computer.
            </small>

            <hr style={{ border: "none", borderTop: "1px solid var(--border-default)", margin: "28px 0 20px" }} />

            <h2>Context Graph <span className="muted" style={{ fontSize: "12px", fontWeight: 400 }}>(experimental)</span></h2>
            <p className="muted" style={{ marginBottom: "16px" }}>
              Gives AI agents a queryable view of your network graph (topology neighbors,
              related config/drift, knowledge base) plus persistent facts &amp; decisions
              across sessions. Works with any provider above. Off by default — toggling off
              instantly restores prior behavior.
            </p>
            <div className="form-group" style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <label className="toggle-switch" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={contextGraphEnabled}
                  onChange={async (e) => {
                    const next = e.target.checked;
                    setContextGraphEnabled(next);
                    try {
                      await contextGraphSetEnabled(next);
                    } catch (err) {
                      setContextGraphEnabled(!next); // revert on failure
                      setError(err instanceof Error ? err.message : "Failed to update context-graph flag");
                    }
                  }}
                />
                <span className="slider"></span>
              </label>
              <span>{contextGraphEnabled ? "Enabled" : "Disabled"}</span>
            </div>

            <div className="form-group" style={{ marginTop: "12px", opacity: contextGraphEnabled ? 1 : 0.5 }}>
              <label htmlFor="cg-staleness">Memory freshness window (minutes)</label>
              <input
                id="cg-staleness"
                type="number"
                min={1}
                value={contextGraphStalenessMin}
                disabled={!contextGraphEnabled}
                onChange={(e) => setContextGraphStalenessMin(Number(e.target.value))}
                onBlur={async () => {
                  const mins = Math.max(1, Math.round(contextGraphStalenessMin || 0));
                  setContextGraphStalenessMin(mins);
                  try {
                    await contextGraphSetStaleness(mins * 60);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Failed to update freshness window");
                  }
                }}
                style={{ maxWidth: "140px" }}
              />
              <small className="hint">
                Remembered facts older than this are treated as stale and re-fetched
                live instead of answered from memory. Default 120 (2 hours).
              </small>
            </div>
          </div>
        )}
        {activeTab === "appearance" && <AppearanceSettingsTab />}
        {activeTab === "editor" && <EditorSettingsTab />}

        {activeTab === "mcp" && (
          <div className="tab-content">
            <div className="tab-header">
              <h2>MCP Servers</h2>
              <button onClick={() => setShowImport(true)} className="primary">
                Import from JSON
              </button>
            </div>

            {error && (
              <div className="error-message">
                <strong>Error:</strong> {error}
              </div>
            )}

            {loading ? (
              <p className="muted">Loading...</p>
            ) : mcpServers.length === 0 ? (
              <div className="empty-state">
                <p className="muted">No MCP servers configured.</p>
                <p className="muted">Click "Import from JSON" to add servers.</p>
              </div>
            ) : (
              <div className="servers-list">
                {mcpServers.map((server) => (
                  <div key={server.id} className="server-item">
                    <div className="server-header">
                      <div className="server-name">
                        <strong>{server.name}</strong>
                        <span className="transport-badge">{server.transport}</span>
                      </div>
                      <div className="server-actions">
                        <label className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={server.enabled}
                            onChange={() => toggleServer(server.id)}
                          />
                          <span className="slider"></span>
                        </label>
                        <button
                          onClick={() => deleteServer(server.id)}
                          className="delete-btn"
                          title="Delete"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    <div className="server-details">
                      {server.transport === "stdio" ? (
                        <>
                          {server.command_json && (() => {
                            try {
                              const cmdConfig = JSON.parse(server.command_json);
                              return (
                                <>
                                  <div className="detail-row">
                                    <span className="label">Command:</span>
                                    <code>{cmdConfig.cmd || ''}</code>
                                  </div>
                                  {cmdConfig.args && cmdConfig.args.length > 0 && (
                                    <div className="detail-row">
                                      <span className="label">Args:</span>
                                      <code>{cmdConfig.args.join(" ")}</code>
                                    </div>
                                  )}
                                </>
                              );
                            } catch {
                              return null;
                            }
                          })()}
                          {server.env_json && (() => {
                            try {
                              const env = JSON.parse(server.env_json);
                              return Object.keys(env).length > 0 && (
                                <div className="detail-row">
                                  <span className="label">Env:</span>
                                  <code>{Object.keys(env).join(", ")}</code>
                                </div>
                              );
                            } catch {
                              return null;
                            }
                          })()}
                        </>
                      ) : (
                        <div className="detail-row">
                          <span className="label">URL:</span>
                          <code>{server.url}</code>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "skills" && (
          <div className="tab-content">
            <div className="tab-header">
              <h2>Skills</h2>
              <div style={{ display: "flex", gap: "8px" }}>
                <button onClick={() => setShowCreateSkill(true)} className="primary">
                  Create Skill
                </button>
                <button onClick={loadSkills} className="secondary" disabled={skillsLoading}>
                  {skillsLoading ? "Reloading..." : "Reload"}
                </button>
              </div>
            </div>

            {error && (
              <div className="error-message">
                <strong>Error:</strong> {error}
              </div>
            )}

            {skillsLoading ? (
              <p className="muted">Loading skills...</p>
            ) : (
              <SkillsList onSelectSkill={selectSkill} />
            )}
          </div>
        )}

        {activeTab === "networkArchitect" && <NetworkArchitectSettingsTab />}

        {activeTab === "agents" && (
          <div className="tab-content">
            <div className="tab-header">
              <h2>Agents</h2>
              <div style={{ display: "flex", gap: "8px" }}>
                <button onClick={() => setShowCreateAgent(true)} className="primary">
                  Create Agent
                </button>
                <button
                  onClick={loadAgents}
                  className="secondary"
                  disabled={agentsLoading}
                >
                  {agentsLoading ? "Reloading..." : "Reload"}
                </button>
              </div>
            </div>

            <p className="muted" style={{ marginBottom: "16px" }}>
              Specialized personas that compose skills + MCP tools. Each terminal tab
              can have an active agent; the agent's system prompt, model override,
              attached skills, and MCP tool catalog are injected into every chat message
              from that tab.
            </p>

            {error && (
              <div className="error-message">
                <strong>Error:</strong> {error}
              </div>
            )}

            {agentsLoading ? (
              <p className="muted">Loading agents...</p>
            ) : agents.length === 0 ? (
              <div className="empty-state">
                <p className="muted">No agents configured.</p>
                <p className="muted">
                  Click "Create Agent" to add one. Agents are stored at{" "}
                  <code>~/.ccie-terminal/agents/</code>.
                </p>
              </div>
            ) : (
              <div className="servers-list">
                {agents.map((a) => (
                  <div key={a.id} className="server-item">
                    <div className="server-header">
                      <div className="server-name">
                        <strong>{a.name}</strong>
                        <span className="transport-badge">{a.id}</span>
                        {a.executionMode === "code" && (
                          <span className="badge-code">Code Execution</span>
                        )}
                      </div>
                      <div className="server-actions">
                        <button
                          className="secondary"
                          onClick={() => handleEditAgent(a)}
                          title="Edit"
                          style={{ marginRight: "8px" }}
                        >
                          Edit
                        </button>
                        <button
                          className="delete-btn"
                          onClick={() => handleDeleteAgent(a.id)}
                          title="Delete"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="server-details">
                      <div className="detail-row">
                        <span className="label">Description:</span>
                        <code>{a.description}</code>
                      </div>
                      {a.modelOverride && (
                        <div className="detail-row">
                          <span className="label">Model override:</span>
                          <code>
                            {a.modelOverride.provider} / {a.modelOverride.model}
                          </code>
                        </div>
                      )}
                      {a.attachedSkills.length > 0 && (
                        <div className="detail-row">
                          <span className="label">Skills:</span>
                          <code>{a.attachedSkills.join(", ")}</code>
                        </div>
                      )}
                      {a.attachedMcpServers.length > 0 && (
                        <div className="detail-row">
                          <span className="label">MCP:</span>
                          <code>{a.attachedMcpServers.join(", ")}</code>
                        </div>
                      )}
                      {a.allowedCommands.length > 0 && (
                        <div className="detail-row">
                          <span className="label">Allowed:</span>
                          <code>{a.allowedCommands.join(" | ")}</code>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "rag" && <RagSettingsTab />}

        {activeTab === "ftp" && <FtpSettingsTab visible={activeTab === "ftp"} />}

        {activeTab === "tftp" && <TftpSettingsTab visible={activeTab === "tftp"} />}

        {activeTab === "gitci" && <GitCiSettingsTab />}

        {activeTab === "updates" && <UpdatesSettingsTab />}

        {activeTab === "pyats" && <PyatsSettingsTab />}

        {activeTab === "topolograph" && <TopolographSettingsTab />}

        {activeTab === "proxmox" && <ProxmoxSettingsTab />}

        {activeTab === "agentComputers" && <AgentComputersSettingsTab />}

        {activeTab === "stealthwatch" && <StealthwatchSettingsTab />}
        {activeTab === "ise" && <IseSettingsTab />}
        {activeTab === "vendorKeywords" && <VendorKeywordsSettingsTab />}
        {activeTab === "cml" && <CmlSettingsTab />}
        {activeTab === "catalyst_center" && <CatalystCenterSettingsTab />}
        {activeTab === "splunk" && <SplunkSettingsTab />}
        {activeTab === "aci" && <AciSettingsTab />}
        {activeTab === "gnmi" && <GnmiSettingsTab />}
        {activeTab === "fmc" && <FmcSettingsTab />}
        {activeTab === "thousandeyes" && <ThousandEyesSettingsTab />}
        {activeTab === "meraki" && <MerakiSettingsTab />}
        {activeTab === "secure_endpoint" && <SecureEndpointSettingsTab />}
        {activeTab === "cisco_xdr" && <CiscoXdrSettingsTab />}
        {activeTab === "mist" && <MistSettingsTab />}
        {activeTab === "grafana" && <GrafanaSettingsTab />}
        {activeTab === "zabbix" && <ZabbixSettingsTab />}
        {activeTab === "prometheus" && <PrometheusSettingsTab />}
        {activeTab === "netbox" && <NetboxSettingsTab />}
        {activeTab === "sketchfab" && <SketchfabSettingsTab />}
        {activeTab === "whatsapp" && <WhatsAppSettingsTab />}

        {activeTab === "terminal" && <TerminalSettingsTab />}

        {activeTab === "browser" && <SettingsBrowserTab />}
          </div>
        </div>

        {showImport && (
          <ImportMcpServer onImport={handleImport} onClose={() => setShowImport(false)} />
        )}

        {selectedSkill && (
          <SkillDetail skill={selectedSkill} onClose={() => selectSkill(null)} />
        )}

        {showCreateSkill && (
          <div className="settings-overlay" onClick={() => setShowCreateSkill(false)}>
            <div className="settings-window" style={{ maxWidth: "600px", height: "auto", maxHeight: "80vh" }} onClick={(e) => e.stopPropagation()}>
              <div className="settings-header">
                <h2>Create New Skill</h2>
                <button className="close-btn" onClick={() => setShowCreateSkill(false)}>
                  ✕
                </button>
              </div>
              <div style={{ padding: "20px", overflowY: "auto" }}>
                <div className="form-group">
                  <label htmlFor="skill-name">Skill Name</label>
                  <input
                    id="skill-name"
                    type="text"
                    value={newSkillName}
                    onChange={(e) => setNewSkillName(e.target.value)}
                    placeholder="e.g., my-custom-skill"
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="skill-description">Description</label>
                  <input
                    id="skill-description"
                    type="text"
                    value={newSkillDescription}
                    onChange={(e) => setNewSkillDescription(e.target.value)}
                    placeholder="What does this skill do?"
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="skill-content">Skill Content (Markdown)</label>
                  <textarea
                    id="skill-content"
                    value={newSkillContent}
                    onChange={(e) => setNewSkillContent(e.target.value)}
                    placeholder={`---
name: my-skill
description: Brief description of what this skill does
---

# Skill Instructions

## Purpose
Explain what this skill helps with.

## Usage
How to invoke: /my-skill [args]

## Steps
1. First, do this
2. Then, do that
3. Finally, complete with this

## Example
\`\`\`bash
# Example command
echo "Hello from my skill"
\`\`\`

## Scripts
If you upload Python scripts, reference them like:
- Run analyze.py with: python analyze.py <args>
- Scripts are available in the skill's directory`}
                    rows={15}
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      background: "var(--surface-chrome)",
                      border: "1px solid var(--border-default)",
                      borderRadius: "4px",
                      color: "var(--text-primary)",
                      fontSize: "12px",
                      fontFamily: "monospace",
                      resize: "vertical",
                    }}
                  />
                  <small className="hint">
                    Use markdown format. The placeholder shows a template structure.
                  </small>
                </div>

                <div className="form-group">
                  <label htmlFor="skill-scripts">Python Scripts (Optional)</label>
                  <input
                    id="skill-scripts"
                    type="file"
                    accept=".py"
                    multiple
                    onChange={handleScriptUpload}
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      background: "var(--surface-chrome)",
                      border: "1px solid var(--border-default)",
                      borderRadius: "4px",
                      color: "var(--text-primary)",
                      fontSize: "13px",
                    }}
                  />
                  <small className="hint">
                    Upload Python scripts that this skill can execute. Scripts will be saved in the skill's directory.
                  </small>
                  {newSkillScripts.length > 0 && (
                    <div style={{ marginTop: "8px" }}>
                      <small style={{ color: "var(--accent)" }}>
                        {newSkillScripts.length} file{newSkillScripts.length !== 1 ? 's' : ''} selected: {newSkillScripts.map(f => f.name).join(', ')}
                      </small>
                    </div>
                  )}
                </div>

                <div className="form-actions">
                  <button className="primary" onClick={handleCreateSkill}>
                    Create Skill
                  </button>
                  <button className="secondary" onClick={() => setShowCreateSkill(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showCreateAgent && (
          <div className="settings-overlay" onClick={closeAgentModal}>
            <div
              className="settings-window"
              style={{ maxWidth: "720px", height: "auto", maxHeight: "90vh" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="settings-header">
                <h2>{editingAgentId ? `Edit Agent: ${newAgentName}` : "Create New Agent"}</h2>
                <button className="close-btn" onClick={closeAgentModal}>
                  ✕
                </button>
              </div>
              <div style={{ padding: "20px", overflowY: "auto" }}>
                <div className="form-group">
                  <label htmlFor="agent-name">Name</label>
                  <input
                    id="agent-name"
                    type="text"
                    value={newAgentName}
                    onChange={(e) => setNewAgentName(e.target.value)}
                    placeholder="e.g., bgp-debugger"
                  />
                  <small className="hint">
                    Lowercase letters, numbers, hyphens. Will be used as the directory
                    name.
                  </small>
                </div>

                <div className="form-group">
                  <label htmlFor="agent-description">Description</label>
                  <input
                    id="agent-description"
                    type="text"
                    value={newAgentDescription}
                    onChange={(e) => setNewAgentDescription(e.target.value)}
                    placeholder="Short summary of what this agent specializes in"
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="agent-system-prompt">System prompt</label>
                  <textarea
                    id="agent-system-prompt"
                    value={newAgentSystemPrompt}
                    onChange={(e) => setNewAgentSystemPrompt(e.target.value)}
                    placeholder={`You are an expert BGP network engineer.
When the user asks about routing issues, diagnose step by step.
Prefer 'show' commands before 'debug' commands.`}
                    rows={8}
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      background: "var(--surface-chrome)",
                      border: "1px solid var(--border-default)",
                      borderRadius: "4px",
                      color: "var(--text-primary)",
                      fontSize: "13px",
                      fontFamily: "monospace",
                      resize: "vertical",
                    }}
                  />
                </div>

                <div className="form-group">
                  <label>
                    <input
                      type="checkbox"
                      checked={newAgentUseOverride}
                      onChange={(e) => setNewAgentUseOverride(e.target.checked)}
                      style={{ marginRight: "8px" }}
                    />
                    Override global AI model
                  </label>
                  {newAgentUseOverride && (
                    <div style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
                      <select
                        value={newAgentProvider}
                        onChange={(e) => setNewAgentProvider(e.target.value as AIProvider)}
                        style={{ flex: "0 0 40%" }}
                      >
                        <option value="anthropic">Anthropic</option>
                        <option value="openai">OpenAI</option>
                        <option value="google">Google</option>
                        <option value="vllm">vLLM</option>
                        <option value="ollama">Ollama</option>
                      </select>
                      <input
                        type="text"
                        value={newAgentModel}
                        onChange={(e) => setNewAgentModel(e.target.value)}
                        placeholder="Model name (e.g., gpt-4-turbo)"
                        style={{ flex: 1 }}
                      />
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <label>Attached skills</label>
                  <div className="checkbox-list">
                    {skillsInStore.length === 0 ? (
                      <p className="muted" style={{ margin: "4px 0", fontSize: "12px" }}>
                        No skills available. Add skills in the Skills tab.
                      </p>
                    ) : (
                      skillsInStore.map((s) => {
                        const checked = newAgentAttachedSkills.includes(s.id);
                        return (
                          <label key={s.id} className="checkbox-row">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setNewAgentAttachedSkills(
                                  checked
                                    ? newAgentAttachedSkills.filter((id) => id !== s.id)
                                    : [...newAgentAttachedSkills, s.id]
                                )
                              }
                            />
                            <span>{s.name} <code>({s.id})</code></span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="form-group">
                  <label>Attached MCP servers</label>
                  <div className="checkbox-list">
                    {mcpServers.length === 0 ? (
                      <p className="muted" style={{ margin: "4px 0", fontSize: "12px" }}>
                        No MCP servers configured. Add them in the MCP tab.
                      </p>
                    ) : (
                      mcpServers.map((s) => {
                        const checked = newAgentAttachedMcp.includes(s.id);
                        return (
                          <label key={s.id} className="checkbox-row">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setNewAgentAttachedMcp(
                                  checked
                                    ? newAgentAttachedMcp.filter((id) => id !== s.id)
                                    : [...newAgentAttachedMcp, s.id]
                                )
                              }
                            />
                            <span>{s.name} <code>({s.transport})</code></span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="form-group">
                  <label htmlFor="agent-allowed">Allowed command regexes (one per line)</label>
                  <textarea
                    id="agent-allowed"
                    value={newAgentAllowedCommands}
                    onChange={(e) => setNewAgentAllowedCommands(e.target.value)}
                    placeholder={`^show \n^ping \n^traceroute `}
                    rows={4}
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      background: "var(--surface-chrome)",
                      border: "1px solid var(--border-default)",
                      borderRadius: "4px",
                      color: "var(--text-primary)",
                      fontSize: "12px",
                      fontFamily: "monospace",
                      resize: "vertical",
                    }}
                  />
                  <small className="hint">
                    Proposed commands that don't match any regex will show a warning but
                    can still be approved.
                  </small>
                </div>

                <div className="form-group">
                  <label htmlFor="execution-mode">Execution Mode</label>
                  <select
                    id="execution-mode"
                    value={newAgentExecutionMode}
                    onChange={(e) => setNewAgentExecutionMode(e.target.value as "react" | "code" | "react-code")}
                  >
                    <option value="react">ReACT (Tool Calling)</option>
                    <option value="code">Code Execution</option>
                    <option value="react-code">ReACT + Code (Hybrid)</option>
                  </select>
                  <p className="field-hint">
                    ReACT: Traditional tool calling (default). Code: LLM writes Python code for CLI tools.
                    ReACT + Code: hybrid reasoning loop that writes and runs Python.
                  </p>
                </div>

                <div className="form-group">
                  <label htmlFor="engine">Execution Engine</label>
                  <select
                    id="engine"
                    value={newAgentEngine || "legacy"}
                    onChange={(e) => setNewAgentEngine(e.target.value as "deepagents" | "legacy")}
                  >
                    <option value="legacy">Legacy (Hand-rolled ReAct)</option>
                    <option value="deepagents">DeepAgents (LangChain/LangGraph)</option>
                  </select>
                  <p className="field-hint">
                    Legacy: Original implementation. DeepAgents: New framework with planning, subagents, and self-verification (beta).
                  </p>
                </div>

                <div className="form-actions">
                  <button className="primary" onClick={handleCreateAgent}>
                    {editingAgentId ? "Save Changes" : "Create Agent"}
                  </button>
                  <button
                    className="secondary"
                    onClick={closeAgentModal}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
