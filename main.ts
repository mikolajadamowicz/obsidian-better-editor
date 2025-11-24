import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, EditorPosition } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	mySetting: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default'
}

// Types for block structure
interface Block {
	startLine: number;
	endLine: number;
	type: 'paragraph' | 'list' | 'heading' | 'code' | 'blockquote' | 'blank';
	indent: number;
	parent?: Block;
	children: Block[];
	content: string;
}

interface SelectionState {
	lastSelectionRange: { from: number; to: number } | null;
	lastActionTime: number;
	currentLevel: number;
}

// Block detection and hierarchy utilities
class BlockAnalyzer {
	/**
	 * Detects the indentation level of a line (number of leading spaces/tabs)
	 */
	static getIndentLevel(line: string): number {
		const match = line.match(/^(\s*)/);
		if (!match) return 0;
		// Count tabs as 4 spaces
		return match[1].replace(/\t/g, '    ').length;
	}

	/**
	 * Determines the block type of a line
	 */
	static getBlockType(line: string): Block['type'] {
		const trimmed = line.trim();

		if (trimmed === '') return 'blank';
		if (/^#{1,6}\s/.test(trimmed)) return 'heading';
		if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) return 'list';
		if (/^>\s/.test(trimmed)) return 'blockquote';
		if (/^```/.test(trimmed)) return 'code';

		return 'paragraph';
	}

	/**
	 * Parses the document into a hierarchical block structure
	 */
	static parseBlocks(doc: string): Block[] {
		const lines = doc.split('\n');
		const blocks: Block[] = [];
		let i = 0;
		let inCodeBlock = false;

		while (i < lines.length) {
			const line = lines[i];
			const type = this.getBlockType(line);
			const indent = this.getIndentLevel(line);

			// Handle code blocks specially
			if (type === 'code') {
				inCodeBlock = !inCodeBlock;
				if (inCodeBlock) {
					// Start of code block - find the end
					const startLine = i;
					i++;
					while (i < lines.length && this.getBlockType(lines[i]) !== 'code') {
						i++;
					}
					blocks.push({
						startLine,
						endLine: i,
						type: 'code',
						indent: 0,
						children: [],
						content: lines.slice(startLine, i + 1).join('\n')
					});
					i++;
					inCodeBlock = false;
					continue;
				}
			}

			// Skip blank lines (but track them)
			if (type === 'blank') {
				i++;
				continue;
			}

			// Group consecutive lines of the same type and indent into a block
			const startLine = i;
			let endLine = i;
			const blockType = type;
			const blockIndent = indent;

			if (type === 'list') {
				// For lists, include subsequent lines with greater indent (continuations)
				i++;
				while (i < lines.length) {
					const nextLine = lines[i];
					const nextType = this.getBlockType(nextLine);
					const nextIndent = this.getIndentLevel(nextLine);

					// Continue if it's a list item at same or greater indent, or blank line
					if (nextType === 'blank') {
						i++;
						continue;
					}
					if (nextType === 'list' && nextIndent >= blockIndent) {
						endLine = i;
						i++;
					} else if (nextIndent > blockIndent && nextType !== 'list') {
						// Continuation of list item (wrapped text)
						endLine = i;
						i++;
					} else {
						break;
					}
				}
			} else if (type === 'paragraph') {
				// For paragraphs, include until blank line or different block type
				i++;
				while (i < lines.length) {
					const nextLine = lines[i];
					const nextType = this.getBlockType(nextLine);
					const nextIndent = this.getIndentLevel(nextLine);

					if (nextType === 'blank') {
						break;
					}
					if (nextType === 'paragraph' && Math.abs(nextIndent - blockIndent) <= 2) {
						endLine = i;
						i++;
					} else {
						break;
					}
				}
			} else {
				// Headings and blockquotes are single-line blocks
				i++;
			}

			blocks.push({
				startLine,
				endLine,
				type: blockType,
				indent: blockIndent,
				children: [],
				content: lines.slice(startLine, endLine + 1).join('\n')
			});
		}

		// Build hierarchy based on indentation
		this.buildHierarchy(blocks);

		return blocks;
	}

	/**
	 * Builds parent-child relationships based on indentation
	 */
	static buildHierarchy(blocks: Block[]): void {
		const stack: Block[] = [];

		for (const block of blocks) {
			// Pop blocks from stack that are not parents of current block
			while (stack.length > 0 && stack[stack.length - 1].indent >= block.indent) {
				stack.pop();
			}

			// If stack is not empty, top block is parent
			if (stack.length > 0) {
				const parent = stack[stack.length - 1];
				block.parent = parent;
				parent.children.push(block);
			}

			stack.push(block);
		}
	}

	/**
	 * Finds the block containing a specific line
	 */
	static findBlockAtLine(blocks: Block[], line: number): Block | null {
		for (const block of blocks) {
			if (line >= block.startLine && line <= block.endLine) {
				// Check children first
				const childBlock = this.findBlockAtLine(block.children, line);
				return childBlock || block;
			}
		}
		return null;
	}

	/**
	 * Gets all sibling blocks at the same level
	 */
	static getSiblings(block: Block, allBlocks: Block[]): Block[] {
		if (block.parent) {
			return block.parent.children;
		}
		// Root level blocks
		return allBlocks.filter(b => !b.parent);
	}

	/**
	 * Gets the parent block or root blocks
	 */
	static getParentLevelBlocks(block: Block, allBlocks: Block[]): Block[] {
		if (block.parent) {
			return this.getSiblings(block.parent, allBlocks);
		}
		// Already at root, return all root blocks
		return allBlocks.filter(b => !b.parent);
	}
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	selectionState: SelectionState = {
		lastSelectionRange: null,
		lastActionTime: 0,
		currentLevel: 0
	};

	async onload() {
		await this.loadSettings();

		// Register the progressive block selection keymap
		this.registerEditorExtension(
			Prec.high(keymap.of([
				{
					key: 'Mod-a',
					run: (view: EditorView) => {
						return this.handleProgressiveSelection(view);
					}
				}
			]))
		);

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', (_evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor: Editor, _view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection('Sample Editor Command');
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}

	/**
	 * Handles progressive block selection when Cmd+A / Ctrl+A is pressed
	 */
	handleProgressiveSelection(view: EditorView): boolean {
		const state = view.state;
		const doc = state.doc;
		const selection = state.selection.main;
		const currentTime = Date.now();

		// Get document text and current cursor position
		const docText = doc.toString();
		const cursorLine = doc.lineAt(selection.head).number - 1; // 0-indexed

		// Parse blocks
		const blocks = BlockAnalyzer.parseBlocks(docText);
		const currentBlock = BlockAnalyzer.findBlockAtLine(blocks, cursorLine);

		if (!currentBlock) {
			// Fallback to default behavior (select all)
			view.dispatch({
				selection: EditorSelection.create([
					EditorSelection.range(0, doc.length)
				])
			});
			return true;
		}

		// Check if this is a continuation of previous selection
		const timeSinceLastAction = currentTime - this.selectionState.lastActionTime;
		const isContinuation =
			timeSinceLastAction < 1000 && // Within 1 second
			this.selectionState.lastSelectionRange !== null &&
			selection.from === this.selectionState.lastSelectionRange.from &&
			selection.to === this.selectionState.lastSelectionRange.to;

		let newFrom: number;
		let newTo: number;

		if (!isContinuation) {
			// First Cmd+A: Select text in current block
			// Check if we already have a partial selection within the block
			const blockStartPos = this.getLineStartPosition(doc, currentBlock.startLine);
			const blockEndPos = this.getLineEndPosition(doc, currentBlock.endLine);

			if (selection.from !== blockStartPos || selection.to !== blockEndPos) {
				// Select the entire current block
				newFrom = blockStartPos;
				newTo = blockEndPos;
				this.selectionState.currentLevel = 0;
			} else {
				// Already selected current block, go to next level
				newFrom = blockStartPos;
				newTo = blockEndPos;
				this.selectionState.currentLevel = 1;
			}
		} else {
			// Continue expanding selection
			this.selectionState.currentLevel++;

			if (this.selectionState.currentLevel === 1) {
				// Second Cmd+A: Select all siblings at current level
				const siblings = BlockAnalyzer.getSiblings(currentBlock, blocks);
				if (siblings.length > 0) {
					const firstBlock = siblings[0];
					const lastBlock = siblings[siblings.length - 1];
					newFrom = this.getLineStartPosition(doc, firstBlock.startLine);
					newTo = this.getLineEndPosition(doc, lastBlock.endLine);
				} else {
					newFrom = selection.from;
					newTo = selection.to;
				}
			} else if (this.selectionState.currentLevel === 2) {
				// Third Cmd+A: Select parent level
				const parentBlocks = BlockAnalyzer.getParentLevelBlocks(currentBlock, blocks);
				if (parentBlocks.length > 0 && currentBlock.parent) {
					const firstBlock = parentBlocks[0];
					const lastBlock = parentBlocks[parentBlocks.length - 1];
					newFrom = this.getLineStartPosition(doc, firstBlock.startLine);
					newTo = this.getLineEndPosition(doc, lastBlock.endLine);
				} else {
					// No parent, select all document
					newFrom = 0;
					newTo = doc.length;
					this.selectionState.currentLevel = 3;
				}
			} else {
				// Fourth Cmd+A and beyond: Select entire document
				newFrom = 0;
				newTo = doc.length;
			}
		}

		// Apply the new selection
		view.dispatch({
			selection: EditorSelection.create([
				EditorSelection.range(newFrom, newTo)
			]),
			scrollIntoView: true
		});

		// Update state
		this.selectionState.lastSelectionRange = { from: newFrom, to: newTo };
		this.selectionState.lastActionTime = currentTime;

		return true; // Prevent default behavior
	}

	/**
	 * Gets the character position of the start of a line
	 */
	getLineStartPosition(doc: any, lineNumber: number): number {
		const line = doc.line(lineNumber + 1); // CodeMirror lines are 1-indexed
		return line.from;
	}

	/**
	 * Gets the character position of the end of a line
	 */
	getLineEndPosition(doc: any, lineNumber: number): number {
		const line = doc.line(lineNumber + 1); // CodeMirror lines are 1-indexed
		return line.to;
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Setting #1')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.mySetting)
				.onChange(async (value) => {
					this.plugin.settings.mySetting = value;
					await this.plugin.saveSettings();
				}));
	}
}
