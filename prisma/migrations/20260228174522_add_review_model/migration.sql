-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "asin" TEXT,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "author" TEXT,
    "rating" DOUBLE PRECISION,
    "reviewDate" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "sentiment" TEXT NOT NULL,
    "compound" DOUBLE PRECISION NOT NULL,
    "sentimentPos" DOUBLE PRECISION,
    "sentimentNeu" DOUBLE PRECISION,
    "sentimentNeg" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Review_productId_idx" ON "Review"("productId");

-- CreateIndex
CREATE INDEX "Review_sentiment_idx" ON "Review"("sentiment");

-- CreateIndex
CREATE INDEX "Review_asin_idx" ON "Review"("asin");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
