//! Authoritative v1 definition validation. No YAML input executes code or commands.
use super::model::*;
use super::policy::CommandPolicy;
use serde::de::{self, DeserializeOwned, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::Deserializer;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const MAX_YAML_BYTES: usize = 256 * 1024;
pub const MAX_TEMPLATE_BYTES: usize = 64 * 1024;
pub struct DefinitionValidator;
impl DefinitionValidator {
    pub fn validate(&self, draft: &ConfigDraft, catalog: &Catalog) -> ValidationReport {
        let diagnostics = self.parse(draft, catalog).err().unwrap_or_default();
        ValidationReport {
            valid: diagnostics.is_empty(),
            draft_hash: Self::draft_hash(draft),
            diagnostics,
            affected_targets: match &draft.scope {
                ConfigScope::Device(id) => vec![id.clone()],
                ConfigScope::Local => vec!["local".into()],
                _ => vec![],
            },
        }
    }
    pub fn draft_hash(draft: &ConfigDraft) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(draft).expect("ConfigDraft contains only strings and enums")
            )
        )
    }
    /// Returns typed documents only after all structural and reference checks succeed.
    pub fn parse(
        &self,
        draft: &ConfigDraft,
        catalog: &Catalog,
    ) -> Result<(WidgetDocument, LayoutDocument), Vec<Diagnostic>> {
        let widgets: WidgetDocument = parse_document(&draft.widgets_yaml).map_err(|mut d| {
            d.path = format!("widgets_yaml{}", d.path);
            vec![d]
        })?;
        let layouts: LayoutDocument = parse_document(&draft.layouts_yaml).map_err(|mut d| {
            d.path = format!("layouts_yaml{}", d.path);
            vec![d]
        })?;
        let mut diagnostics = Vec::new();
        if widgets.schema_version != 1 || layouts.schema_version != 1 {
            diagnostics.push(Diagnostic::new(
                "schema_version",
                "Only schema_version: 1 is supported",
                "schema_version",
            ));
        }
        for (id, text) in &draft.templates {
            if !valid_name(id) || text.is_empty() || text.len() > MAX_TEMPLATE_BYTES {
                diagnostics.push(Diagnostic::new(
                    "template_limit",
                    "Template IDs must be identifiers; text must contain 1–65536 bytes",
                    format!("templates.{id}"),
                ));
            }
        }
        let mut ids = BTreeSet::new();
        for widget in &widgets.widgets {
            if !ids.insert(widget.widget.clone()) {
                diagnostics.push(Diagnostic::new(
                    "duplicate_widget",
                    "Repeated widget ID",
                    &widget.widget,
                ));
            }
            if let Err(d) = self.validate_widget(widget, draft, catalog) {
                diagnostics.push(d);
            }
        }
        let available: BTreeSet<_> = catalog.widgets.keys().chain(ids.iter()).collect();
        let mut layout_ids = BTreeSet::new();
        for layout in &layouts.layouts {
            let result = (|| {
                ensure(
                    valid_name(&layout.layout) && layout_ids.insert(&layout.layout),
                    "layout",
                    "Layout ID must be unique and valid",
                    &layout.layout,
                )?;
                let mut sections = BTreeSet::new();
                for section in &layout.sections {
                    ensure(
                        valid_name(&section.id)
                            && sections.insert(&section.id)
                            && !section.title.trim().is_empty(),
                        "section",
                        "Section requires a unique ID and title",
                        &layout.layout,
                    )?;
                    for row in &section.rows {
                        ensure(
                            !row.is_empty()
                                && row.iter().map(|entry| u32::from(entry.span)).sum::<u32>() <= 12,
                            "layout_span",
                            "Rows must contain 1–12 total columns",
                            &layout.layout,
                        )?;
                        for entry in row {
                            ensure(
                                entry.span > 0
                                    && entry.span <= 12
                                    && available.contains(&entry.widget),
                                "layout_reference",
                                "Layout must reference an existing widget with span 1–12",
                                &entry.widget,
                            )?;
                        }
                    }
                }
                Ok(())
            })();
            if let Err(d) = result {
                diagnostics.push(d);
            }
        }
        if diagnostics.is_empty() {
            Ok((widgets, layouts))
        } else {
            Err(diagnostics)
        }
    }
    fn validate_widget(
        &self,
        widget: &WidgetDefinition,
        draft: &ConfigDraft,
        catalog: &Catalog,
    ) -> Result<(), Diagnostic> {
        let path = &widget.widget;
        ensure(
            valid_name(path) && !widget.title.trim().is_empty(),
            "widget",
            "Widget requires an identifier and nonempty title",
            path,
        )?;
        let minimum = match &widget.source {
            WidgetSource::Local { .. } => {
                ensure(
                    matches!(draft.scope, ConfigScope::Local),
                    "scope",
                    "Local sources require Local scope",
                    path,
                )?;
                1
            }
            WidgetSource::Ssh {
                commands,
                templates,
            } => {
                ensure(
                    !matches!(draft.scope, ConfigScope::Local),
                    "scope",
                    "SSH sources require a profile or device scope",
                    path,
                )?;
                ensure(
                    !commands.is_empty() && commands.keys().eq(templates.keys()),
                    "source_binding",
                    "Commands and templates must bind the same platforms",
                    path,
                )?;
                if let ConfigScope::Profile(platform) = draft.scope {
                    ensure(
                        commands.contains_key(&platform),
                        "source_binding",
                        "Source must bind the selected profile platform",
                        path,
                    )?;
                }
                let mut minimum = 5;
                for (platform, command) in commands {
                    let admitted = CommandPolicy::admit(*platform, command)?;
                    minimum = minimum.max(admitted.cost().min_interval_seconds);
                    let id = &templates[platform];
                    ensure(
                        draft.templates.contains_key(id) || catalog.templates.contains_key(id),
                        "template_reference",
                        "Source template does not exist",
                        path,
                    )?;
                    if let Some(asset) = catalog.templates.get(id) {
                        ensure(
                            asset.platform == *platform && asset.command == *command,
                            "template_binding",
                            "Template platform/command does not match the source",
                            path,
                        )?;
                    }
                }
                minimum
            }
        };
        ensure(
            widget.interval >= minimum && widget.interval <= 3600,
            "interval",
            format!("Interval must be {minimum}–3600 seconds for this source/cost"),
            path,
        )?;
        ensure(
            !widget.fields.is_empty(),
            "fields",
            "At least one normalized field is required",
            path,
        )?;
        for (field, aliases) in &widget.fields {
            ensure(
                valid_name(field)
                    && !aliases.is_empty()
                    && aliases.iter().all(|alias| !alias.trim().is_empty()),
                "field_alias",
                "Fields require valid names and nonempty ordered aliases",
                path,
            )?;
        }
        let base: BTreeSet<_> = widget.fields.keys().cloned().collect();
        let mut fields = base.clone();
        for (name, transform) in widget.rates.iter().chain(widget.deltas.iter()) {
            ensure(
                valid_name(name)
                    && fields.insert(name.clone())
                    && base.contains(&transform.field)
                    && transform.multiplier.is_finite(),
                "transform",
                "Rates/deltas require unique output names, an input field and a finite multiplier",
                path,
            )?;
        }
        // Computes reference base/rate/delta fields, never other computes: no implicit evaluation order or cycles.
        let inputs = fields.clone();
        for (name, expression) in &widget.computes {
            ensure(
                valid_name(name) && fields.insert(name.clone()),
                "compute",
                "Compute output name must be unique",
                path,
            )?;
            let expression = ArithmeticExpression::parse(expression)?;
            ensure(
                expression
                    .fields()
                    .iter()
                    .all(|field| inputs.contains(field)),
                "compute_reference",
                "Compute references an unknown field; chaining computes is unsupported",
                path,
            )?;
        }
        for key in &widget.key {
            ensure(
                base.contains(key),
                "key_reference",
                "Keys must reference normalized input fields",
                path,
            )?;
        }
        ensure(
            widget.key.iter().collect::<BTreeSet<_>>().len() == widget.key.len(),
            "key_reference",
            "Composite keys cannot repeat fields",
            path,
        )?;
        let references: Vec<&str> = match &widget.view {
            WidgetView::Table { columns } | WidgetView::Kv { columns } => {
                ensure(
                    !columns.is_empty()
                        && columns.iter().all(|column| !column.label.trim().is_empty()),
                    "view",
                    "Columns require labels",
                    path,
                )?;
                columns.iter().map(|column| column.field.as_str()).collect()
            }
            WidgetView::Chart { series } => {
                ensure(
                    !series.is_empty()
                        && series.iter().all(|column| !column.label.trim().is_empty()),
                    "view",
                    "Chart series require labels",
                    path,
                )?;
                series.iter().map(|column| column.field.as_str()).collect()
            }
            WidgetView::Stat {
                field,
                label,
                aggregation,
            } => {
                ensure(
                    !label.trim().is_empty()
                        && (*aggregation == Aggregation::Count || field.is_some()),
                    "view",
                    "Stat requires a label and field unless aggregation is count",
                    path,
                )?;
                field.iter().map(String::as_str).collect()
            }
        };
        for field in references {
            ensure(
                fields.contains(field),
                "view_reference",
                "View references an unknown field",
                path,
            )?;
        }
        if let Some(history) = &widget.history {
            for field in &history.fields {
                ensure(
                    fields.contains(field),
                    "history_reference",
                    "History references an unknown field",
                    path,
                )?;
            }
        }
        for alert in &widget.alerts {
            ensure(
                fields.contains(&alert.field) && !alert.message.trim().is_empty(),
                "alert_reference",
                "Alert requires an existing field and message",
                path,
            )?;
            if let ThresholdValue::Number(value) = alert.value {
                ensure(
                    value.is_finite(),
                    "alert_value",
                    "Alert threshold must be finite",
                    path,
                )?;
            }
            ensure(
                matches!(alert.op, PredicateOp::Eq | PredicateOp::Ne)
                    || matches!(alert.value, ThresholdValue::Number(_)),
                "alert_type",
                "Ordered thresholds require numeric values",
                path,
            )?;
        }
        Ok(())
    }
}
fn ensure(
    condition: bool,
    code: &str,
    message: impl Into<String>,
    path: &str,
) -> Result<(), Diagnostic> {
    if condition {
        Ok(())
    } else {
        Err(Diagnostic::new(code, message, path))
    }
}
fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
}

/// Scan tokens before serde_yaml can expand aliases. Scalar punctuation is literal.
fn preflight(text: &str) -> Result<(), Diagnostic> {
    use yaml_rust2::scanner::{Scanner, TokenType};
    ensure(
        text.len() <= MAX_YAML_BYTES,
        "yaml_limit",
        "YAML document exceeds 256KiB",
        "",
    )?;
    let mut scanner = Scanner::new(text.chars());
    let mut depth = 0usize;
    while let Some(token) = scanner.next_token().map_err(|error| Diagnostic {
        code: "yaml_syntax".into(),
        message: error.info().into(),
        path: "".into(),
        line: Some(error.marker().line() as u32),
        column: Some(error.marker().col() as u32 + 1),
    })? {
        match token.1 {
            TokenType::Alias(_)
            | TokenType::Anchor(_)
            | TokenType::Tag(_, _)
            | TokenType::TagDirective(_, _) => {
                return Err(Diagnostic { code: "yaml_feature".into(), message: "YAML anchors, aliases and tags are unsupported; quote the value if this punctuation is literal".into(), path: "".into(), line: Some(token.0.line() as u32), column: Some(token.0.col() as u32 + 1) });
            }
            TokenType::BlockSequenceStart
            | TokenType::BlockMappingStart
            | TokenType::FlowSequenceStart
            | TokenType::FlowMappingStart => {
                depth += 1;
                ensure(depth <= 32, "yaml_limit", "YAML nesting exceeds 32", "")?;
            }
            TokenType::BlockEnd | TokenType::FlowSequenceEnd | TokenType::FlowMappingEnd => {
                depth = depth.saturating_sub(1);
            }
            _ => {}
        }
    }
    Ok(())
}

/// Seed enforces depth/duplicates/finite numbers while reading, before typed construction.
struct BoundedValue(usize);
impl<'de> DeserializeSeed<'de> for BoundedValue {
    type Value = serde_yaml::Value;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        if self.0 > 32 {
            return Err(de::Error::custom("YAML nesting exceeds 32"));
        }
        deserializer.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for BoundedValue {
    type Value = serde_yaml::Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a bounded YAML value")
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
        Ok(value.into())
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
        Ok(value.into())
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
        Ok(value.into())
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
        if value.is_finite() {
            Ok(value.into())
        } else {
            Err(E::custom("All numbers must be finite"))
        }
    }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(value.into())
    }
    fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
        Ok(value.into())
    }
    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(serde_yaml::Value::Null)
    }
    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
        self.visit_unit()
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element_seed(BoundedValue(self.0 + 1))? {
            values.push(value);
        }
        Ok(serde_yaml::Value::Sequence(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut mapping: A) -> Result<Self::Value, A::Error> {
        let mut values = serde_yaml::Mapping::new();
        while let Some(key) = mapping.next_key::<String>()? {
            let key = serde_yaml::Value::String(key);
            if values.contains_key(&key) {
                return Err(de::Error::custom("Duplicate mapping key"));
            }
            let value = mapping.next_value_seed(BoundedValue(self.0 + 1))?;
            values.insert(key, value);
        }
        Ok(serde_yaml::Value::Mapping(values))
    }
}
pub fn parse_document<T: DeserializeOwned>(text: &str) -> Result<T, Diagnostic> {
    preflight(text)?;
    let mut documents = serde_yaml::Deserializer::from_str(text);
    let document = documents
        .next()
        .ok_or_else(|| Diagnostic::new("yaml", "Document is empty", ""))?;
    let value = BoundedValue(0).deserialize(document).map_err(yaml_error)?;
    ensure(
        documents.next().is_none(),
        "yaml",
        "Only one YAML document is supported",
        "",
    )?;
    serde_yaml::from_value(value).map_err(yaml_error)
}
fn yaml_error(error: serde_yaml::Error) -> Diagnostic {
    let location = error.location();
    Diagnostic {
        code: "yaml".into(),
        message: error.to_string(),
        path: "".into(),
        line: location.as_ref().map(|l| l.line() as u32),
        column: location.as_ref().map(|l| l.column() as u32),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ArithmeticExpression {
    nodes: Vec<ExpressionNode>,
    root: usize,
}
#[derive(Debug, Clone, PartialEq)]
enum ExpressionNode {
    Number(f64),
    Field(String),
    Unary { minus: bool, node: usize },
    Binary { op: u8, left: usize, right: usize },
}
impl ArithmeticExpression {
    pub fn parse(expression: &str) -> Result<Self, Diagnostic> {
        ensure(
            expression.len() <= 4096,
            "expression_limit",
            "Expression exceeds 4096 bytes",
            "computes",
        )?;
        let mut parser = ExpressionParser {
            text: expression.as_bytes(),
            offset: 0,
            nodes: Vec::new(),
        };
        let root = parser.expression(0, 0)?;
        parser.whitespace();
        ensure(
            parser.offset == parser.text.len(),
            "expression",
            "Only arithmetic, literals and field identifiers are supported",
            "computes",
        )?;
        Ok(Self {
            nodes: parser.nodes,
            root,
        })
    }
    pub fn fields(&self) -> BTreeSet<String> {
        self.nodes
            .iter()
            .filter_map(|node| {
                if let ExpressionNode::Field(name) = node {
                    Some(name.clone())
                } else {
                    None
                }
            })
            .collect()
    }
    pub fn evaluate(&self, fields: &BTreeMap<String, f64>) -> Result<f64, Diagnostic> {
        let mut values: Vec<f64> = Vec::with_capacity(self.nodes.len());
        for node in &self.nodes {
            let value = match node {
                ExpressionNode::Number(value) => *value,
                ExpressionNode::Field(name) => *fields.get(name).ok_or_else(|| {
                    Diagnostic::new(
                        "expression_gap",
                        format!("Missing field {name}"),
                        "computes",
                    )
                })?,
                ExpressionNode::Unary { minus, node } => {
                    if *minus {
                        -values[*node]
                    } else {
                        values[*node]
                    }
                }
                ExpressionNode::Binary { op, left, right } => match op {
                    b'+' => values[*left] + values[*right],
                    b'-' => values[*left] - values[*right],
                    b'*' => values[*left] * values[*right],
                    b'/' => {
                        ensure(
                            values[*right] != 0.0,
                            "expression_gap",
                            "Division by zero",
                            "computes",
                        )?;
                        values[*left] / values[*right]
                    }
                    _ => unreachable!(),
                },
            };
            ensure(
                value.is_finite(),
                "expression_gap",
                "Nonfinite arithmetic result or input",
                "computes",
            )?;
            values.push(value);
        }
        Ok(values[self.root])
    }
}
struct ExpressionParser<'a> {
    text: &'a [u8],
    offset: usize,
    nodes: Vec<ExpressionNode>,
}
impl ExpressionParser<'_> {
    fn whitespace(&mut self) {
        while self
            .text
            .get(self.offset)
            .is_some_and(u8::is_ascii_whitespace)
        {
            self.offset += 1;
        }
    }
    fn push(&mut self, node: ExpressionNode) -> Result<usize, Diagnostic> {
        ensure(
            self.nodes.len() < 64,
            "expression_limit",
            "Expression exceeds 64 AST nodes",
            "computes",
        )?;
        self.nodes.push(node);
        Ok(self.nodes.len() - 1)
    }
    fn expression(&mut self, precedence: u8, depth: usize) -> Result<usize, Diagnostic> {
        ensure(
            depth < 64,
            "expression_limit",
            "Expression nesting exceeds 64",
            "computes",
        )?;
        self.whitespace();
        let first = self.text.get(self.offset).copied();
        let mut left = match first {
            Some(b'+' | b'-') => {
                self.offset += 1;
                let node = self.expression(3, depth + 1)?;
                self.push(ExpressionNode::Unary {
                    minus: first == Some(b'-'),
                    node,
                })?
            }
            Some(b'(') => {
                self.offset += 1;
                let node = self.expression(0, depth + 1)?;
                self.whitespace();
                ensure(
                    self.text.get(self.offset) == Some(&b')'),
                    "expression",
                    "Missing closing parenthesis",
                    "computes",
                )?;
                self.offset += 1;
                node
            }
            Some(c) if c.is_ascii_digit() || c == b'.' => {
                let start = self.offset;
                while self
                    .text
                    .get(self.offset)
                    .is_some_and(|c| c.is_ascii_digit() || *c == b'.')
                {
                    self.offset += 1;
                }
                if self
                    .text
                    .get(self.offset)
                    .is_some_and(|c| matches!(c, b'e' | b'E'))
                {
                    self.offset += 1;
                    if self
                        .text
                        .get(self.offset)
                        .is_some_and(|c| matches!(c, b'+' | b'-'))
                    {
                        self.offset += 1;
                    }
                    while self.text.get(self.offset).is_some_and(u8::is_ascii_digit) {
                        self.offset += 1;
                    }
                }
                let value: f64 = std::str::from_utf8(&self.text[start..self.offset])
                    .unwrap()
                    .parse()
                    .map_err(|_| {
                        Diagnostic::new("expression", "Invalid numeric literal", "computes")
                    })?;
                ensure(
                    value.is_finite(),
                    "expression",
                    "Numeric literals must be finite",
                    "computes",
                )?;
                self.push(ExpressionNode::Number(value))?
            }
            Some(c) if c.is_ascii_alphabetic() || c == b'_' => {
                let start = self.offset;
                self.offset += 1;
                while self
                    .text
                    .get(self.offset)
                    .is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
                {
                    self.offset += 1;
                }
                self.push(ExpressionNode::Field(
                    std::str::from_utf8(&self.text[start..self.offset])
                        .unwrap()
                        .into(),
                ))?
            }
            _ => {
                return Err(Diagnostic::new(
                    "expression",
                    "Expected number, field, sign or parenthesis",
                    "computes",
                ))
            }
        };
        loop {
            self.whitespace();
            let Some(op) = self.text.get(self.offset).copied() else {
                break;
            };
            let binding = match op {
                b'+' | b'-' => 1,
                b'*' | b'/' => 2,
                _ => break,
            };
            if binding <= precedence {
                break;
            }
            self.offset += 1;
            let right = self.expression(binding, depth + 1)?;
            left = self.push(ExpressionNode::Binary { op, left, right })?;
        }
        Ok(left)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schema_examples_match_authoritative_validation() {
        let examples: serde_json::Value =
            serde_json::from_str(include_str!("tests/schema-examples.json")).unwrap();
        let layouts = &examples["valid"][4];
        for widgets in examples["valid"].as_array().unwrap().iter().take(4) {
            let draft = draft(
                &serde_json::to_string(widgets).unwrap(),
                &serde_json::to_string(layouts).unwrap(),
            );
            let result = DefinitionValidator.validate(&draft, &Catalog::default());
            assert!(result.valid, "{:?}", result.diagnostics);
        }
        for invalid in examples["invalid"].as_array().unwrap() {
            assert!(
                !DefinitionValidator
                    .validate(
                        &draft(
                            &serde_json::to_string(invalid).unwrap(),
                            &serde_json::to_string(layouts).unwrap()
                        ),
                        &Catalog::default()
                    )
                    .valid
            );
        }
    }

    use std::collections::BTreeMap;
    const WIDGETS: &str = "schema_version: 1\nwidgets:\n  - widget: cpu\n    title: CPU\n    source: {kind: local, collector: local.cpu}\n    interval: 2\n    key: [core]\n    fields: {core: [core], usage: [usage]}\n    view: {type: table, columns: [{field: usage, label: Usage}]}\n";
    const LAYOUTS: &str = "schema_version: 1\nlayouts:\n  - layout: local\n    platforms: []\n    sections:\n      - id: overview\n        title: Overview\n        rows: [[{widget: cpu, span: 12}]]\n";

    fn draft(widgets: &str, layouts: &str) -> ConfigDraft {
        ConfigDraft {
            scope: ConfigScope::Local,
            widgets_yaml: widgets.into(),
            layouts_yaml: layouts.into(),
            templates: BTreeMap::new(),
            expected_revision: String::new(),
        }
    }

    #[test]
    fn schema_rejects_duplicate_keys_unknown_fields_and_references() {
        let validator = DefinitionValidator;
        assert!(
            validator
                .validate(&draft(WIDGETS, LAYOUTS), &Catalog::default())
                .valid
        );
        for yaml in [
            WIDGETS.replace("title: CPU", "title: CPU\n    title: Other"),
            WIDGETS.replace("title: CPU", "title: CPU\n    py: evil"),
            WIDGETS.replace("key: [core]", "key: [absent]"),
        ] {
            assert!(
                !validator
                    .validate(&draft(&yaml, LAYOUTS), &Catalog::default())
                    .valid
            );
        }
        assert!(
            !validator
                .validate(
                    &draft(WIDGETS, &LAYOUTS.replace("widget: cpu", "widget: unknown")),
                    &Catalog::default()
                )
                .valid
        );
    }
    #[test]
    fn yaml_boundary_rejects_expansion_depth_and_nonfinite() {
        let validator = DefinitionValidator;
        for title in ["&a CPU", "*a", "!custom CPU", "!!str CPU"] {
            assert!(
                !validator
                    .validate(
                        &draft(
                            &WIDGETS.replace("title: CPU", &format!("title: {title}")),
                            LAYOUTS
                        ),
                        &Catalog::default()
                    )
                    .valid,
                "{title}"
            );
        }
        for title in [
            "'CPU & * !'",
            "\"CPU \\\" & !\"",
            "'CPU '' & !'",
            "'CPU\n      & * !'",
            "CPU # & * !",
            "|\n      literal ' & * !",
            ">\n      literal \" & * !",
        ] {
            assert!(
                validator
                    .validate(
                        &draft(
                            &WIDGETS.replace("title: CPU", &format!("title: {title}")),
                            LAYOUTS
                        ),
                        &Catalog::default()
                    )
                    .valid,
                "{title}"
            );
        }
        let deep = format!("{}0{}", "[".repeat(33), "]".repeat(33));
        assert!(parse_document::<serde_yaml::Value>(&deep).is_err());
        assert!(parse_document::<serde_yaml::Value>("{a: 1, a: 2}").is_err());
        assert!(
            !validator
                .validate(
                    &draft(&WIDGETS.replace("interval: 2", "interval: .nan"), LAYOUTS),
                    &Catalog::default()
                )
                .valid
        );
    }
    #[test]
    fn plain_apostrophes_cannot_hide_yaml_aliases() {
        for yaml in [
            "title: don't\nbase: &x [a]\nvalue: *x",
            "title: foo{'junk\nbase: &x [a]\nvalue: *x",
            "title: hello\n  'junk\nbase: &x [a]\nvalue: *x",
            "title: hello\n  - 'junk\nbase: &x [a]\nvalue: *x",
            "title: foo:'junk\nbase: &x [a]\nvalue: *x",
            "title: hello 'world\nbase: &x [a]\nvalue: *x",
            "title: |\n  'x\nbase: &a [a]\nvalue: *a",
        ] {
            assert!(parse_document::<serde_yaml::Value>(yaml).is_err(), "{yaml}");
        }
        assert!(parse_document::<serde_yaml::Value>("title: don't").is_ok());
        assert!(parse_document::<serde_yaml::Value>("title: >\n  quoted \"x\" & * !\n").is_ok());
        assert!(
            parse_document::<serde_yaml::Value>("%TAG !e! tag:example.com,2026:\n---\na: 1")
                .is_err()
        );
        assert!(parse_document::<serde_yaml::Value>("title: \"unterminated").is_err());
        assert!(parse_document::<serde_yaml::Value>(r#"{"title":"A & B * C ! D"}"#).is_ok());
    }
    #[test]
    fn expressions_are_bounded_and_report_gaps() {
        let fields = BTreeMap::from([("a".into(), 4.0), ("b".into(), 2.0)]);
        assert_eq!(
            ArithmeticExpression::parse("-(a + b) * 2 / b")
                .unwrap()
                .evaluate(&fields)
                .unwrap(),
            -6.0
        );
        for expression in ["a()", "a.b", "a ** 2", "1e999", "", "a +"] {
            assert!(
                ArithmeticExpression::parse(expression).is_err(),
                "{expression}"
            );
        }
        assert!(ArithmeticExpression::parse(&vec!["a"; 34].join("+")).is_err());
        assert!(
            ArithmeticExpression::parse(&format!("{}1{}", "(".repeat(2000), ")".repeat(2000)))
                .is_err()
        );
        assert!(ArithmeticExpression::parse(&format!("{}1", "-".repeat(2000))).is_err());
        assert!(ArithmeticExpression::parse("a / 0")
            .unwrap()
            .evaluate(&fields)
            .is_err());
        assert!(ArithmeticExpression::parse("missing")
            .unwrap()
            .evaluate(&fields)
            .is_err());
    }
    #[test]
    fn ssh_bindings_costs_and_document_limits_are_enforced() {
        let source = "{kind: ssh, commands: {iosxe: show version}, templates: {iosxe: version}}";
        let widgets = WIDGETS
            .replace("{kind: local, collector: local.cpu}", source)
            .replace("interval: 2", "interval: 60");
        let mut draft = draft(&widgets, LAYOUTS);
        draft.scope = ConfigScope::Profile(Platform::Iosxe);
        let asset = TemplateAsset {
            id: "version".into(),
            platform: Platform::Iosxe,
            command: "show version".into(),
            text: "template".into(),
            sha256: "hash".into(),
        };
        let mut catalog = Catalog::default();
        assert!(!DefinitionValidator.validate(&draft, &catalog).valid);
        catalog.templates.insert("version".into(), asset);
        assert!(DefinitionValidator.validate(&draft, &catalog).valid);
        draft.widgets_yaml = widgets.replace("interval: 60", "interval: 5");
        assert!(!DefinitionValidator.validate(&draft, &catalog).valid);
        draft.widgets_yaml = widgets.clone();
        catalog.templates.get_mut("version").unwrap().command = "show inventory".into();
        assert!(!DefinitionValidator.validate(&draft, &catalog).valid);
        assert!(parse_document::<serde_yaml::Value>(&"x".repeat(MAX_YAML_BYTES + 1)).is_err());
        let mut local = self::draft(WIDGETS, LAYOUTS);
        local
            .templates
            .insert("template".into(), "x".repeat(MAX_TEMPLATE_BYTES + 1));
        assert!(
            !DefinitionValidator
                .validate(&local, &Catalog::default())
                .valid
        );
    }
    #[test]
    fn source_and_derived_references_are_validated() {
        let validator = DefinitionValidator;
        for yaml in [
            WIDGETS.replace("local.cpu", "cpu"),
            WIDGETS.replace("interval: 2", "interval: 0"),
            WIDGETS.replace("field: usage", "field: unknown"),
            format!("{WIDGETS}    computes: {{total: 'unknown + 1'}}\n"),
            format!("{WIDGETS}    rates: {{rate: {{field: usage, multiplier: .inf}}}}\n"),
        ] {
            assert!(
                !validator
                    .validate(&draft(&yaml, LAYOUTS), &Catalog::default())
                    .valid,
                "{yaml}"
            );
        }
    }
}
