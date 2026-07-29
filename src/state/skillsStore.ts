import { create } from "zustand";

export type Skill = {
  id: string;
  name: string;
  description: string;
  when_to_use: string;
  scripts: string[];
  allowed_commands: string[];
  body: string; // markdown playbook
  path: string;
};

type SkillsStore = {
  skills: Skill[];
  selectedSkill: Skill | null;
  setSkills: (skills: Skill[]) => void;
  selectSkill: (skill: Skill | null) => void;
  reloadSkills: () => Promise<void>;
};

export const useSkillsStore = create<SkillsStore>((set) => ({
  skills: [],
  selectedSkill: null,
  setSkills: (skills) => set({ skills }),
  selectSkill: (skill) => set({ selectedSkill: skill }),
  reloadSkills: async () => {
    // This will be called from components to trigger a reload
    // The actual reload is handled by the backend
  },
}));
