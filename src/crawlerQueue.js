'use strict';

const { v4: uuidv4 } = require('uuid');

class CrawlerQueue {
    constructor(runJob) {
        this.runJob = runJob;
        this.jobs = new Map();
        this.queue = [];
        this.currentJob = null;
    }

    createJob(payload) {
        const job = {
            id: uuidv4(),
            status: 'queued',
            payload,
            createdAt: Date.now(),
            result: null,
            error: null,
            listeners: new Set(),
            aheadCount: this.queue.length
        };
        this.jobs.set(job.id, job);
        this.queue.push(job);
        this.broadcastQueuePositions();
        this.maybeStartNext();
        return job;
    }

    getJob(jobId) {
        return this.jobs.get(jobId) || null;
    }

    attach(jobId, res) {
        const job = this.getJob(jobId);
        if (!job) {
            return null;
        }
        job.listeners.add(res);
        res.on('close', () => job.listeners.delete(res));

        if (job.status === 'queued') {
            this.send(job, 'queue', { aheadCount: job.aheadCount });
        } else if (job.status === 'running') {
            this.send(job, 'queue', { aheadCount: 0 });
        } else if (job.status === 'done') {
            this.send(job, 'done', job.result || {});
            res.end();
        } else if (job.status === 'error') {
            this.send(job, 'error', { error: job.error?.message || job.error || 'Job failed' });
            res.end();
        }

        return job;
    }

    send(job, event, data) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of job.listeners) {
            if (res.writableEnded) continue;
            try {
                res.write(payload);
            } catch (_) {
                // best-effort
            }
        }
    }

    maybeStartNext() {
        if (this.currentJob) return;
        const next = this.queue.shift();
        if (!next) return;
        this.currentJob = next;
        next.status = 'running';
        next.aheadCount = 0;
        this.send(next, 'queue', { aheadCount: 0 });
        this.broadcastQueuePositions();
        this.execute(next);
    }

    broadcastQueuePositions() {
        this.queue.forEach((job, index) => {
            job.aheadCount = index + (this.currentJob ? 1 : 0);
            this.send(job, 'queue', { aheadCount: job.aheadCount });
        });
    }

    async execute(job) {
        const payload = {
            ...job.payload,
            onProgress: (data) => this.send(job, 'progress', data)
        };
        try {
            const result = await this.runJob(payload);
            job.result = result || {};
            job.status = 'done';
            this.send(job, 'done', job.result);
        } catch (error) {
            job.error = error;
            job.status = 'error';
            this.send(job, 'error', { error: error.message || 'Job failed' });
        } finally {
            this.finish(job);
        }
    }

    finish(job) {
        for (const res of job.listeners) {
            if (!res.writableEnded) {
                try { res.end(); } catch (_) { /* ignore */ }
            }
        }
        job.listeners.clear();
        if (this.currentJob && this.currentJob.id === job.id) {
            this.currentJob = null;
        }
        this.broadcastQueuePositions();
        this.maybeStartNext();
    }
}

module.exports = CrawlerQueue;


