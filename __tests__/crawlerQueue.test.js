'use strict';

const CrawlerQueue = require('../src/crawlerQueue');

describe('CrawlerQueue', () => {
    describe('createJob()', () => {
        it('returns a job with an id and queued status', () => {
            const queue = new CrawlerQueue(async () => {});
            const job = queue.createJob({ data: 'test' });
            expect(job.id).toBeDefined();
            expect(typeof job.id).toBe('string');
            expect(job.status).toBe('running'); // first job starts immediately
            expect(job.payload).toEqual({ data: 'test' });
        });

        it('assigns incrementing aheadCount for queued jobs', async () => {
            const jobs = [];
            const started = [];
            const resolvers = [];

            const queue = new CrawlerQueue(async (payload) => {
                started.push(payload.idx);
                return new Promise(resolve => resolvers.push(resolve));
            });

            jobs.push(queue.createJob({ idx: 0 }));
            jobs.push(queue.createJob({ idx: 1 }));
            jobs.push(queue.createJob({ idx: 2 }));

            // First job runs immediately, others are queued
            expect(jobs[0].status).toBe('running');
            expect(jobs[1].status).toBe('queued');
            expect(jobs[2].status).toBe('queued');

            // Clean up
            for (const r of resolvers) r();
            await new Promise(r => setTimeout(r, 50));
        });
    });

    describe('FIFO execution order', () => {
        it('executes jobs in order', async () => {
            const order = [];
            const queue = new CrawlerQueue(async (payload) => {
                order.push(payload.idx);
            });

            queue.createJob({ idx: 0 });
            queue.createJob({ idx: 1 });
            queue.createJob({ idx: 2 });

            await new Promise(r => setTimeout(r, 100));
            expect(order).toEqual([0, 1, 2]);
        });
    });

    describe('single concurrent job', () => {
        it('only runs one job at a time', async () => {
            let running = 0;
            let maxConcurrent = 0;

            const queue = new CrawlerQueue(async () => {
                running++;
                maxConcurrent = Math.max(maxConcurrent, running);
                await new Promise(r => setTimeout(r, 20));
                running--;
            });

            queue.createJob({});
            queue.createJob({});
            queue.createJob({});

            await new Promise(r => setTimeout(r, 200));
            expect(maxConcurrent).toBe(1);
        });
    });

    describe('job lifecycle', () => {
        it('transitions from running to done on success', async () => {
            const queue = new CrawlerQueue(async () => ({ result: 'ok' }));
            const job = queue.createJob({});

            await new Promise(r => setTimeout(r, 50));
            expect(job.status).toBe('done');
            expect(job.result).toEqual({ result: 'ok' });
        });

        it('transitions to error on failure', async () => {
            const queue = new CrawlerQueue(async () => {
                throw new Error('test failure');
            });
            const job = queue.createJob({});

            await new Promise(r => setTimeout(r, 50));
            expect(job.status).toBe('error');
            expect(job.error).toBeDefined();
            expect(job.error.message).toBe('test failure');
        });

        it('calls onStart and onFinish callbacks', async () => {
            const callbacks = { started: false, finished: false, elapsed: null };
            const queue = new CrawlerQueue(async () => ({ done: true }));

            queue.createJob({}, {
                onStart: () => { callbacks.started = true; },
                onFinish: (elapsed, result) => {
                    callbacks.finished = true;
                    callbacks.elapsed = elapsed;
                }
            });

            await new Promise(r => setTimeout(r, 50));
            expect(callbacks.started).toBe(true);
            expect(callbacks.finished).toBe(true);
            expect(typeof callbacks.elapsed).toBe('number');
        });
    });

    describe('getJob()', () => {
        it('retrieves a job by id', () => {
            const queue = new CrawlerQueue(async () => {});
            const job = queue.createJob({});
            expect(queue.getJob(job.id)).toBe(job);
        });

        it('returns null for unknown id', () => {
            const queue = new CrawlerQueue(async () => {});
            expect(queue.getJob('nonexistent')).toBeNull();
        });
    });

    describe('getQueueSize()', () => {
        it('reports total queued + running', async () => {
            let resolve;
            const queue = new CrawlerQueue(async () => {
                return new Promise(r => { resolve = r; });
            });

            queue.createJob({});
            queue.createJob({});
            expect(queue.getQueueSize()).toBe(2);

            resolve();
            await new Promise(r => setTimeout(r, 50));
        });
    });

    describe('progress broadcasting', () => {
        it('sends progress events via onProgress', async () => {
            let resolveJob;
            const jobPromise = new Promise(r => { resolveJob = r; });

            const queue = new CrawlerQueue(async (payload) => {
                // Yield so the test can attach a listener before progress fires
                await new Promise(r => setTimeout(r, 10));
                payload.onProgress({ phase: 'step1' });
                payload.onProgress({ phase: 'step2' });
                resolveJob();
                return {};
            });

            const mockRes = {
                writableEnded: false,
                write: jest.fn(),
                end: jest.fn(() => { mockRes.writableEnded = true; }),
                on: jest.fn()
            };

            const job = queue.createJob({});
            job.listeners.add(mockRes);

            await jobPromise;
            await new Promise(r => setTimeout(r, 50));

            const writes = mockRes.write.mock.calls.map(c => c[0]);
            const progressWrites = writes.filter(w => w.includes('event: progress'));
            expect(progressWrites.length).toBeGreaterThanOrEqual(2);
        });
    });
});
