import { randomUUID } from "node:crypto";
import type { CreateJobInput, Job } from "@rescue/contracts";

export interface JobStore {
  create(input: CreateJobInput): Promise<Job>;
  get(id: string): Promise<Job | null>;
  list(organizationId?: string): Promise<Job[]>;
}

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();
  async create(input: CreateJobInput): Promise<Job> {
    const now = new Date().toISOString();
    const job: Job = { ...input, id: randomUUID(), status: "DRAFT", createdAt: now, updatedAt: now };
    this.jobs.set(job.id, job); return job;
  }
  async get(id: string) { return this.jobs.get(id) ?? null; }
  async list(organizationId?: string) {
    return [...this.jobs.values()].filter((job) => !organizationId || job.organizationId === organizationId).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
}
