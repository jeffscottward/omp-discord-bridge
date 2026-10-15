import { seedSecretValuesForTests } from "../src/secrets.ts";

// Suite-wide: outbound tests must not depend on secret files in the real home directory.
seedSecretValuesForTests([]);
