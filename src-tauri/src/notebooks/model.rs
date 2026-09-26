//! Typed cell graph for runnable notebooks.
//!
//! The frontmatter is stored verbatim as `frontmatter_json` in SQLite; the
//! cell graph is stored row-per-cell in `notebook_cells`. The original raw
//! markdown body is stored in `notebooks.body_markdown` so byte-stable export
//! is possible for imported notebooks.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum NotebookCell {
    Markdown {
        content: String,
    },
    Command {
        content: String,
        #[serde(default)]
        metadata: CommandMeta,
    },
    Approval {
        content: String,
    },
    Assertion {
        spec: AssertionSpec,
    },
    Parameter {
        params: Vec<ParameterSpec>,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CommandMeta {
    #[serde(default)]
    pub timeout_s: Option<u32>,
    #[serde(default)]
    pub expect_exit: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssertionSpec {
    pub command: String,
    pub jsonpath: String,
    pub op: AssertionOp,
    pub expected: serde_json::Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssertionOp {
    Equals,
    NotEquals,
    Contains,
    GreaterThan,
    LessThan,
    Exists,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParameterSpec {
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub default: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Frontmatter {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub vendor: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub parameters: Vec<ParameterSpec>,
}

impl Default for Frontmatter {
    fn default() -> Self {
        Self {
            title: "Untitled".into(),
            description: None,
            vendor: None,
            platform: None,
            parameters: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Notebook {
    pub frontmatter: Frontmatter,
    pub cells: Vec<NotebookCell>,
    pub body_markdown: String,
}
