-- Migration 022: Add 'characters' question type to recruitment_questions
-- This enables a special Characters element in recruitment forms that lets
-- applicants link their registered in-game characters to their application.

ALTER TABLE recruitment_questions
  MODIFY COLUMN question_type
    ENUM('text','textarea','select','radio','characters') NOT NULL DEFAULT 'text';
