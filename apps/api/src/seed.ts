import type { MemorySeed } from "./store/memory.js";

/**
 * Synthetic development data.
 *
 * Every record here is invented. No real company, person, address or contact
 * detail appears, and this module is only ever loaded for the in-memory store,
 * which the config refuses to use in production.
 */

export const ORG_NORDLICHT = "11111111-1111-4111-8111-111111111111";
export const ORG_WESERTECH = "22222222-2222-4222-8222-222222222222";
export const PROVIDER_HANSA = "33333333-3333-4333-8333-333333333333";
export const PROVIDER_ROLAND = "44444444-4444-4444-8444-444444444444";
export const PROVIDER_PENDING = "55555555-5555-4555-8555-555555555555";

const YEAR_FROM_NOW = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
const YEAR_AGO = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

export const developmentSeed: MemorySeed = {
  organizations: [
    { id: ORG_NORDLICHT, name: "Nordlicht Möbel GmbH" },
    { id: ORG_WESERTECH, name: "Weser Tech AG" }
  ],
  users: [
    {
      id: "aaaa1111-1111-4111-8111-111111111111",
      subject: "dev|customer-admin",
      email: "admin@nordlicht.example",
      name: "Katrin Vogel",
      memberships: [
        {
          id: "m-1",
          role: "CUSTOMER_ADMIN",
          organizationId: ORG_NORDLICHT,
          providerId: null
        }
      ]
    },
    {
      id: "aaaa2222-2222-4222-8222-222222222222",
      subject: "dev|customer-member",
      email: "ops@nordlicht.example",
      name: "Tobias Reimer",
      memberships: [
        { id: "m-2", role: "CUSTOMER_MEMBER", organizationId: ORG_NORDLICHT, providerId: null }
      ]
    },
    {
      id: "aaaa3333-3333-4333-8333-333333333333",
      subject: "dev|other-customer",
      email: "admin@wesertech.example",
      name: "Lena Brandt",
      memberships: [
        { id: "m-3", role: "CUSTOMER_ADMIN", organizationId: ORG_WESERTECH, providerId: null }
      ]
    },
    {
      id: "aaaa4444-4444-4444-8444-444444444444",
      subject: "dev|dispatcher",
      email: "dispatch@rescue.example",
      name: "Sven Kohl",
      memberships: [{ id: "m-4", role: "DISPATCHER", organizationId: null, providerId: null }]
    },
    {
      id: "aaaa5555-5555-4555-8555-555555555555",
      subject: "dev|compliance",
      email: "compliance@rescue.example",
      name: "Miriam Falk",
      memberships: [{ id: "m-5", role: "COMPLIANCE", organizationId: null, providerId: null }]
    },
    {
      id: "aaaa6666-6666-4666-8666-666666666666",
      subject: "dev|provider-hansa",
      email: "dispo@hansa-transport.example",
      name: "Jörg Petersen",
      memberships: [
        { id: "m-6", role: "PROVIDER_ADMIN", organizationId: null, providerId: PROVIDER_HANSA }
      ]
    },
    {
      id: "aaaa7777-7777-4777-8777-777777777777",
      subject: "dev|provider-roland",
      email: "dispo@roland-logistik.example",
      name: "Annika Schuster",
      memberships: [
        { id: "m-7", role: "PROVIDER_ADMIN", organizationId: null, providerId: PROVIDER_ROLAND }
      ]
    },
    {
      id: "aaaa8888-8888-4888-8888-888888888888",
      subject: "dev|admin",
      email: "admin@rescue.example",
      name: "Platform Admin",
      memberships: [{ id: "m-8", role: "ADMIN", organizationId: null, providerId: null }]
    }
  ],
  providers: [
    {
      id: PROVIDER_HANSA,
      legalName: "Hansa Transport UG",
      status: "ACTIVE",
      basePostalCode: "28195",
      serviceRadiusKm: 40,
      serviceTypes: ["FAILED_DELIVERY", "BULKY_RETURN", "COMPANY_SURPLUS"],
      contactEmail: "dispo@hansa-transport.example",
      vatId: "DE000000001",
      vehicles: [
        {
          id: "v-hansa-1",
          vehicleClass: "LARGE_VAN",
          payloadKg: 1200,
          volumeM3: 12,
          active: true
        },
        { id: "v-hansa-2", vehicleClass: "BOX_VAN", payloadKg: 3000, volumeM3: 22, active: true }
      ],
      documents: [
        {
          id: "d-hansa-1",
          type: "LIABILITY_INSURANCE",
          status: "VERIFIED",
          storageKey: "seed/hansa/liability.pdf",
          expiresAt: YEAR_FROM_NOW
        },
        {
          id: "d-hansa-2",
          type: "TRADE_LICENCE",
          status: "VERIFIED",
          storageKey: "seed/hansa/trade.pdf",
          expiresAt: null
        }
      ]
    },
    {
      id: PROVIDER_ROLAND,
      legalName: "Roland Logistik GmbH",
      status: "ACTIVE",
      basePostalCode: "28309",
      serviceRadiusKm: 25,
      serviceTypes: ["FAILED_DELIVERY"],
      contactEmail: "dispo@roland-logistik.example",
      vatId: "DE000000002",
      vehicles: [
        { id: "v-roland-1", vehicleClass: "SMALL_VAN", payloadKg: 800, volumeM3: 6, active: true }
      ],
      documents: [
        {
          id: "d-roland-1",
          type: "LIABILITY_INSURANCE",
          status: "VERIFIED",
          // Deliberately expired, so the eligibility gate has something real
          // to exclude in a development environment.
          storageKey: "seed/roland/liability.pdf",
          expiresAt: YEAR_AGO
        },
        {
          id: "d-roland-2",
          type: "TRADE_LICENCE",
          status: "VERIFIED",
          storageKey: "seed/roland/trade.pdf",
          expiresAt: null
        }
      ]
    },
    {
      id: PROVIDER_PENDING,
      legalName: "Weserfracht Neu UG",
      status: "PENDING",
      basePostalCode: "28195",
      serviceRadiusKm: 50,
      serviceTypes: ["FAILED_DELIVERY", "BULKY_RETURN"],
      contactEmail: "info@weserfracht.example",
      vatId: null,
      vehicles: [
        { id: "v-pending-1", vehicleClass: "TRUCK", payloadKg: 7000, volumeM3: 40, active: true }
      ],
      documents: []
    }
  ]
};
