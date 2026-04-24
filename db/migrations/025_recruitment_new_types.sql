-- Migration 025: Add new question types to recruitment_questions
-- Adds 'checkbox', 'header', and 'separator' types.

ALTER TABLE recruitment_questions
  MODIFY COLUMN question_type
    ENUM('text','textarea','select','radio','characters','checkbox','header','separator') NOT NULL DEFAULT 'text';
