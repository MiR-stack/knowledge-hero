import { customType } from "drizzle-orm/pg-core";

export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

export const ltree = customType<{ data: string; driverData: string }>({
  dataType() {
    return "ltree";
  },
});

export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});
