const { EntitySchema } = require("typeorm");

module.exports = new EntitySchema({
  name: "Certificate",
  tableName: "certificates",
  columns: {
    certificateNo: {
      primary: true,
      type: "varchar",
      name: "certificate_no",
      length: 255,
    },
    payload: {
      type: "jsonb",
      nullable: false,
    },
    createdAt: {
      type: "timestamptz",
      name: "created_at",
      createDate: true,
    },
    updatedAt: {
      type: "timestamptz",
      name: "updated_at",
      updateDate: true,
    },
  },
});
