import * as vscode from 'vscode';
import * as path from 'path';

export interface Bookmark {
    id: string;
    fileUri: string;
    text: string;
    note: string;
}

export class BookmarkManager {
    public static async getBookmarksFileUri(): Promise<vscode.Uri | undefined> {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return undefined;
        }
        const root = vscode.workspace.workspaceFolders[0].uri;
        return vscode.Uri.joinPath(root, '.tmp', 'bookmarks.json');
    }

    public static async getBookmarks(): Promise<Bookmark[]> {
        const uri = await this.getBookmarksFileUri();
        if (!uri) return [];
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            const text = new TextDecoder().decode(data);
            return JSON.parse(text);
        } catch (e) {
            return [];
        }
    }

    public static async addBookmark(fileUri: string, text: string, note: string): Promise<string> {
        const bookmarks = await this.getBookmarks();
        const id = 'bm-' + Date.now().toString() + Math.random().toString(36).substr(2, 5);
        bookmarks.push({ id, fileUri, text, note });
        
        const uri = await this.getBookmarksFileUri();
        if (uri) {
            const tmpDir = vscode.Uri.joinPath(uri, '..');
            try {
                await vscode.workspace.fs.createDirectory(tmpDir);
            } catch (e) {} // Ignore if exists
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(bookmarks, null, 2)));
        }
        return id;
    }
}
