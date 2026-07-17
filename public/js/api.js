(function() {
    "use strict";

    window.HtmlVRApi = {
        async fetchProjects() {
            const res = await fetch('/api/projects');
            if (!res.ok) throw new Error("Failed to fetch projects");
            return await res.json();
        },

        async loadProjectState(projectName) {
            const res = await fetch(`/api/project/state?project=${encodeURIComponent(projectName)}`);
            if (!res.ok) throw new Error(`Failed to load project state for ${projectName}`);
            return await res.json();
        },

        async saveProjectState(projectName, projectState) {
            const res = await fetch(`/api/project/state?project=${encodeURIComponent(projectName)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(projectState)
            });
            if (!res.ok) throw new Error("Failed to save project state");
            return await res.json();
        },

        async fetchCompositions(projectName) {
            const res = await fetch(`/api/compositions?project=${encodeURIComponent(projectName)}`);
            if (!res.ok) throw new Error("Failed to fetch compositions");
            return await res.json();
        },

        async deleteFile(projectName, fileName) {
            const res = await fetch(`/api/delete?name=${encodeURIComponent(fileName)}&project=${encodeURIComponent(projectName)}`, {
                method: 'DELETE'
            });
            if (!res.ok) throw new Error("Failed to delete file");
            return await res.json();
        },

        async triggerAgent(projectName) {
            const res = await fetch(`/api/agent/trigger?project=${encodeURIComponent(projectName)}`, {
                method: 'POST'
            });
            if (!res.ok) throw new Error("Failed to trigger agent");
            return await res.json();
        },

        async exportProject(projectName) {
            const res = await fetch(`/api/project/export?project=${encodeURIComponent(projectName)}`, {
                method: 'POST'
            });
            if (!res.ok) throw new Error("Failed to export project");
            return await res.json();
        },

        async importProject(projectName, zipData) {
            const res = await fetch(`/api/project/import?project=${encodeURIComponent(projectName)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ zipData })
            });
            if (!res.ok) throw new Error("Failed to import project");
            return await res.json();
        },

        async undoProject(projectName) {
            const res = await fetch(`/api/project/undo?project=${encodeURIComponent(projectName)}`, {
                method: 'POST'
            });
            if (!res.ok) throw new Error("Failed to undo project state");
            return await res.json();
        },

        async checkBackup(projectName) {
            const res = await fetch(`/api/project/has-backup?project=${encodeURIComponent(projectName)}`);
            if (!res.ok) throw new Error("Failed to check backup status");
            return await res.json();
        },

        async uploadFile(formData) {
            const res = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            if (!res.ok) throw new Error("Upload failed");
            return await res.json();
        }
    };
})();
