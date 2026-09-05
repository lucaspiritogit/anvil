-- Embeddings from different models cannot be compared. Clear the OpenAI
-- vectors before changing the column to mxbai-embed-large's 1024 dimensions.
TRUNCATE TABLE project_memories;
