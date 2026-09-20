import { MemoryStore } from "../src/store/memory.js";
import { runStoreConformance } from "./store-conformance.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const PROVIDER_A = "33333333-3333-4333-8333-333333333333";
const PROVIDER_B = "44444444-4444-4444-8444-444444444444";
const ERASEABLE = "55555555-5555-4555-8555-555555555555";
const ERASEABLE_SUBJECT = "test|to-be-erased";

runStoreConformance("MemoryStore", {
  async create() {
    const store = new MemoryStore({
      users: [
        {
          id: ERASEABLE,
          subject: ERASEABLE_SUBJECT,
          email: "erase-me@example.com",
          name: "Zu Loeschen"
        }
      ],
      organizations: [
        { id: ORG_A, name: "Org A" },
        { id: ORG_B, name: "Org B" }
      ],
      providers: [
        {
          id: PROVIDER_A,
          legalName: "Provider A",
          status: "ACTIVE",
          basePostalCode: "28195",
          serviceRadiusKm: 50,
          serviceTypes: ["FAILED_DELIVERY"],
          contactEmail: "a@example.com",
          vatId: null
        },
        {
          id: PROVIDER_B,
          legalName: "Provider B",
          status: "ACTIVE",
          basePostalCode: "28195",
          serviceRadiusKm: 50,
          serviceTypes: ["FAILED_DELIVERY"],
          contactEmail: "b@example.com",
          vatId: null
        }
      ]
    });
    return {
      store,
      organizationA: ORG_A,
      organizationB: ORG_B,
      providerA: PROVIDER_A,
      providerB: PROVIDER_B,
      actor: { userId: "aaaa1111-1111-4111-8111-111111111111", role: "DISPATCHER" as const },
      eraseableSubject: ERASEABLE_SUBJECT
    };
  }
});
