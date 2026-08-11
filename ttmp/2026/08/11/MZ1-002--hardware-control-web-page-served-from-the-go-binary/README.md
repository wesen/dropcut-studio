# Hardware control web page served from the Go binary

This is the document workspace for ticket MZ1-002.

## Structure

- **design/**: Design documents and architecture notes
- **reference/**: Reference documentation and API contracts
- **playbooks/**: Operational playbooks and procedures
- **scripts/**: Utility scripts and automation
- **sources/**: External sources and imported documents
- **various/**: Scratch or meeting notes, working notes
- **archive/**: Optional space for deprecated or reference-only artifacts

## Getting Started

Use docmgr commands to manage this workspace:

- Add documents: `docmgr doc add --ticket MZ1-002 --doc-type design-doc --title "My Design"`
- Import sources: `docmgr import file --ticket MZ1-002 --file /path/to/doc.md`
- Update metadata: `docmgr meta update --ticket MZ1-002 --field Status --value review`
