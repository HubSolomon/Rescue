-- RESCUE initial schema.
--
-- Monetary columns are INTEGER euro cents throughout. There is deliberately no
-- DOUBLE PRECISION or REAL column anywhere in this schema.

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER_ADMIN', 'CUSTOMER_MEMBER', 'PROVIDER_ADMIN', 'PROVIDER_DRIVER', 'DISPATCHER', 'COMPLIANCE', 'ADMIN');
CREATE TYPE "JobType" AS ENUM ('FAILED_DELIVERY', 'BULKY_RETURN', 'COMPANY_SURPLUS');
CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'TRIAGED', 'QUOTED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "Urgency" AS ENUM ('SCHEDULED', 'SAME_DAY', 'URGENT');
CREATE TYPE "VehicleClass" AS ENUM ('CARGO_BIKE', 'SMALL_VAN', 'LARGE_VAN', 'BOX_VAN', 'TRUCK');
CREATE TYPE "ProviderStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED');
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'REJECTED');
CREATE TYPE "DocumentType" AS ENUM ('LIABILITY_INSURANCE', 'CARGO_INSURANCE', 'TRADE_LICENCE', 'WASTE_CARRIER_PERMIT', 'VEHICLE_REGISTRATION');
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED');
CREATE TYPE "OfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN');
CREATE TYPE "AssignmentStatus" AS ENUM ('ACTIVE', 'FELL_THROUGH', 'COMPLETED');
CREATE TYPE "EvidenceKind" AS ENUM ('PICKUP_PHOTO', 'DELIVERY_PHOTO', 'SIGNATURE', 'DAMAGE_REPORT');
CREATE TYPE "EvidenceStatus" AS ENUM ('REQUESTED', 'UPLOADED', 'REJECTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "status" "ProviderStatus" NOT NULL DEFAULT 'PENDING',
    "basePostalCode" TEXT NOT NULL,
    "serviceRadiusKm" INTEGER NOT NULL DEFAULT 30,
    "serviceTypes" "JobType"[],
    "contactEmail" TEXT NOT NULL,
    "vatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "providerId" TEXT,
    "role" "UserRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "registrationHash" TEXT NOT NULL,
    "vehicleClass" "VehicleClass" NOT NULL,
    "payloadKg" INTEGER NOT NULL,
    "volumeM3" DECIMAL(6,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderDocument" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
    "urgency" "Urgency" NOT NULL,
    "pickup" JSONB NOT NULL,
    "destination" JSONB,
    "items" JSONB NOT NULL,
    "stairs" INTEGER NOT NULL DEFAULT 0,
    "liftAvailable" BOOLEAN NOT NULL DEFAULT false,
    "requestedAt" TIMESTAMP(3),
    "customerReference" TEXT,
    "notes" TEXT,
    "approvedVehicleClass" "VehicleClass",
    "approvedWorkers" INTEGER,
    "approvedCircularRoute" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'SENT',
    "netCents" INTEGER NOT NULL,
    "vatCents" INTEGER NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "vatRateBasisPoints" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "breakdown" JSONB,
    "notes" TEXT,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssignmentOffer" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'PENDING',
    "payoutNetCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssignmentOffer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "payoutNetCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "fellThroughAt" TIMESTAMP(3),
    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "status" "EvidenceStatus" NOT NULL DEFAULT 'REQUESTED',
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedAt" TIMESTAMP(3),
    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_subject_key" ON "User"("subject");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

CREATE UNIQUE INDEX "Membership_userId_organizationId_providerId_role_key" ON "Membership"("userId", "organizationId", "providerId", "role");
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");
CREATE INDEX "Membership_organizationId_idx" ON "Membership"("organizationId");
CREATE INDEX "Membership_providerId_idx" ON "Membership"("providerId");

CREATE INDEX "Provider_status_idx" ON "Provider"("status");

CREATE UNIQUE INDEX "Vehicle_providerId_registrationHash_key" ON "Vehicle"("providerId", "registrationHash");
CREATE INDEX "Vehicle_providerId_active_idx" ON "Vehicle"("providerId", "active");

CREATE INDEX "ProviderDocument_providerId_type_status_idx" ON "ProviderDocument"("providerId", "type", "status");

CREATE INDEX "Job_organizationId_createdAt_idx" ON "Job"("organizationId", "createdAt");
CREATE INDEX "Job_status_urgency_idx" ON "Job"("status", "urgency");

CREATE INDEX "Quote_jobId_status_idx" ON "Quote"("jobId", "status");
CREATE INDEX "Quote_organizationId_createdAt_idx" ON "Quote"("organizationId", "createdAt");

CREATE UNIQUE INDEX "AssignmentOffer_jobId_providerId_key" ON "AssignmentOffer"("jobId", "providerId");
CREATE INDEX "AssignmentOffer_jobId_status_idx" ON "AssignmentOffer"("jobId", "status");
CREATE INDEX "AssignmentOffer_status_expiresAt_idx" ON "AssignmentOffer"("status", "expiresAt");

CREATE INDEX "Assignment_jobId_status_idx" ON "Assignment"("jobId", "status");
CREATE INDEX "Assignment_providerId_status_idx" ON "Assignment"("providerId", "status");

CREATE UNIQUE INDEX "Evidence_storageKey_key" ON "Evidence"("storageKey");
CREATE INDEX "Evidence_jobId_kind_idx" ON "Evidence"("jobId", "kind");

CREATE UNIQUE INDEX "IdempotencyKey_organizationId_key_key" ON "IdempotencyKey"("organizationId", "key");
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

CREATE INDEX "JobEvent_jobId_createdAt_idx" ON "JobEvent"("jobId", "createdAt");

CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderDocument" ADD CONSTRAINT "ProviderDocument_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Quote" ADD CONSTRAINT "Quote_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AssignmentOffer" ADD CONSTRAINT "AssignmentOffer_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssignmentOffer" ADD CONSTRAINT "AssignmentOffer_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Monetary integrity. Cents are whole numbers and never negative; gross must
-- equal net plus VAT. Enforced by the database so no application bug, and no
-- future direct SQL, can write an inconsistent amount.
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_amounts_nonnegative" CHECK ("netCents" >= 0 AND "vatCents" >= 0 AND "grossCents" >= 0);
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_gross_is_net_plus_vat" CHECK ("grossCents" = "netCents" + "vatCents");
ALTER TABLE "AssignmentOffer" ADD CONSTRAINT "AssignmentOffer_payout_nonnegative" CHECK ("payoutNetCents" >= 0);
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_payout_nonnegative" CHECK ("payoutNetCents" >= 0);
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_size_positive" CHECK ("sizeBytes" > 0);

-- A membership belongs to an organisation, or a provider, or neither (RESCUE
-- staff) -- never to both at once.
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_single_tenant" CHECK (NOT ("organizationId" IS NOT NULL AND "providerId" IS NOT NULL));

-- At most one ACTIVE assignment per job, enforced by the database rather than
-- by application convention, so a race between two accepting providers cannot
-- double-book a job.
CREATE UNIQUE INDEX "Assignment_one_active_per_job" ON "Assignment"("jobId") WHERE "status" = 'ACTIVE';
