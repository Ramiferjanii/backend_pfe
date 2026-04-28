const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.product.findUnique({where:{id:'c81f7de7-f4cd-431f-a18c-d1bb2cee7b79'}})
    .then(r => console.log(JSON.stringify(r)))
    .catch(console.error)
    .finally(()=>p.$disconnect());
